// Repo state: effective-config reader with per-key ORIGIN tracking.
// Reads git config files directly (~0.7 ms vs ~40 ms per `git config` spawn,
// verified empirically) with mtime caching. The core slice answers exactly three questions:
//   1. is commit/tag/push signing effectively on (and from which origin tag)?
//   2. what is the currently-effective core.hooksPath?
//   3. do protected keys exist in a given origin (for config-source-hiding)?
// Worktree/submodule gitdir graphs live in repo.ts; include.path following is not supported.

import { readFileSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { gitBool } from "./git/booleans.js"
import { discoverRepo } from "./repo.js"

export type OriginTag = "system" | "global" | "local" | "worktree"

export interface RepoState {
  root: string | null
  gitDir: string | null
  /** All config files in low→high precedence order. */
  files(): Array<{ path: string; tag: OriginTag; entries: Record<string, string> }>
  /** Highest-precedence value for a lowercase "section.key". */
  effective(key: string): { value: string; tag: OriginTag; path: string } | undefined
  exists(path: string): boolean
  /** git aliases across all config files: name → expansion. */
  aliases(): Record<string, string>
}

export const PROTECTED_KEYS = [
  "commit.gpgsign",
  "tag.gpgsign",
  "push.gpgsign",
  "tag.forcesignannotated",
  "core.hookspath",
]

function parseIni(text: string): Record<string, string> {
  const entries: Record<string, string> = {}
  let section = ""
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) {
      section = sec[1].trim().toLowerCase()
      continue
    }
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    let value = line.slice(eq + 1).trim()
    // strip one layer of matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
) {
      value = value.slice(1, -1)
    }
    // section names incl. subsections are lowercased — sufficient for the protected
    // protected key set (hook.* config on 2.56 is flat [hook] section keys)
    entries[`${section}.${key}`] = value
  }
  return entries
}

type CachedFile = { mtime: number; entries: Record<string, string> }

export function createRealState(startDir: string): RepoState {
  const cache = new Map<string, CachedFile>()

  const readFileCached = (path: string): Record<string, string> => {
    try {
      const st = statSync(path)
      const hit = cache.get(path)
      if (hit && hit.mtime === st.mtimeMs) return hit.entries
      const entries = parseIni(readFileSync(path, "utf8"))
      cache.set(path, { mtime: st.mtimeMs, entries })
      return entries
    } catch {
      return {}
    }
  }

  const repo = discoverRepo(startDir)

  const fileList = (): Array<{ path: string; tag: OriginTag; entries: Record<string, string> }> => {
    const files: Array<{ path: string; tag: OriginTag; entries: Record<string, string> }> = []
    // system (unless suppressed in the server environment)
    if (!process.env.GIT_CONFIG_NOSYSTEM) {
      const sysCandidates = [join(process.env.ProgramData ?? "/ProgramData", "Git", "config"), "/etc/gitconfig"]
      for (const p of sysCandidates) files.push({ path: p, tag: "system", entries: readFileCached(p) })
    }
    // global: $GIT_CONFIG_GLOBAL, else ~/.config/git/config then ~/.gitconfig (later wins)
    const globalOverride = process.env.GIT_CONFIG_GLOBAL
    if (globalOverride) {
      files.push({ path: globalOverride, tag: "global", entries: readFileCached(globalOverride) })
    } else {
      files.push({ path: join(homedir(), ".config", "git", "config"), tag: "global", entries: readFileCached(join(homedir(), ".config", "git", "config")) })
      files.push({ path: join(homedir(), ".gitconfig"), tag: "global", entries: readFileCached(join(homedir(), ".gitconfig")) })
    }
    if (repo?.gitDir) {
      files.push({ path: join(repo.gitDir, "config"), tag: "local", entries: readFileCached(join(repo.gitDir, "config")) })
      files.push({ path: join(repo.gitDir, "config.worktree"), tag: "worktree", entries: readFileCached(join(repo.gitDir, "config.worktree")) })
    }
    return files.filter((f) => Object.keys(f.entries).length > 0 || f.tag === "local")
  }

  return {
    root: repo?.root ?? null,
    gitDir: repo?.gitDir ?? null,
    files: fileList,
    effective(key: string) {
      const list = fileList()
      for (let i = list.length - 1; i >= 0; i--) {
        const f = list[i]
        if (key in f.entries) return { value: f.entries[key], tag: f.tag, path: f.path }
      }
      return undefined
    },
    exists: (p) => existsSync(p),
    aliases() {
      return collectAliases(fileList())
    },
  }
}

function collectAliases(files: Array<{ entries: Record<string, string> }>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of files) {
    for (const [k, v] of Object.entries(f.entries)) {
      if (k.startsWith("alias.")) out[k.slice("alias.".length)] = v
    }
  }
  return out
}

export function createFixtureState(
  files: Array<{ tag: OriginTag; entries: Record<string, string> }>,
  opts?: { gitDir?: string; root?: string; existing?: string[] },
): RepoState {
  return {
    root: opts?.root ?? null,
    gitDir: opts?.gitDir ?? null,
    files: () => files.map((f, idx) => ({ path: `fixture://${idx}`, tag: f.tag, entries: f.entries })),
    effective(key: string) {
      for (let i = files.length - 1; i >= 0; i--) {
        if (key in files[i].entries) return { value: files[i].entries[key], tag: files[i].tag, path: `fixture://${i}` }
      }
      return undefined
    },
    exists: (p) => opts?.existing?.includes(p) ?? false,
    aliases() {
      return collectAliases(files.map((f) => ({ entries: f.entries })))
    },
  }
}

// ---- derived signing/hook state helpers -------------------------------------

export function commitSigningEnabled(st: RepoState): boolean {
  return gitBool(st.effective("commit.gpgsign")?.value) === true
}

export function tagSigningEnabled(st: RepoState): boolean {
  return gitBool(st.effective("tag.gpgsign")?.value) === true || gitBool(st.effective("tag.forcesignannotated")?.value) === true
}

export function pushSigningEnabled(st: RepoState): boolean {
  return gitBool(st.effective("push.gpgsign")?.value) === true
}

export function hooksPathCurrent(st: RepoState): string | undefined {
  return st.effective("core.hookspath")?.value
}

/** Any protected key meaningfully set in files with the given origin tag? */
export function protectedFromOrigin(st: RepoState, tag: OriginTag): boolean {
  return st
    .files()
    .filter((f) => f.tag === tag)
    .some(
      (f) =>
        PROTECTED_KEYS.some((k) => k in f.entries && gitBool(f.entries[k]) !== false) ||
        Object.keys(f.entries).some((k) => k.startsWith("hook.") && gitBool(f.entries[k]) === true),
)
}

export { parseIni }
