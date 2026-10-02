// Gitdir discovery: never assume `.git` is a directory.
// Reads the `.git` *file* pointer for linked worktrees, follows `commondir`,
// enumerates linked-worktree gitdirs and submodule gitdirs (recursively, for
// nested modules). Pure filesystem — no git spawns (sub-millisecond budget).

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from "node:fs"
import { join, resolve, dirname } from "node:path"

/** Collapse 8.3 short-name / long-name / symlink divergence between sources. */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

export type GitRepo = {
  /** Worktree root where `.git` was found. */
  root: string
  /** This worktree's gitdir (directory, or the pointer target for linked worktrees). */
  gitDir: string
  /** Shared gitdir (main repo's .git); equals gitDir for the main worktree. */
  commonDir: string
  /** Gitdirs of all linked worktrees (<commonDir>/worktrees/*). */
  worktreeGitDirs: string[]
  /** Gitdirs of all submodules, nested included (<commonDir>/modules/**). */
  moduleGitDirs: string[]
}

export function discoverRepo(startDir: string): GitRepo | null {
  let dir = resolve(startDir)
  for (;;) {
    const dotGit = join(dir, ".git")
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return buildRepo(dir, dotGit)
      try {
        const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))
        if (m) return buildRepo(dir, resolve(dir, m[1].trim()))
      } catch {
        // unreadable pointer — no usable gitdir
      }
      return null
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function createFixtureRepo(parts: {
  root: string
  gitDir: string
  commonDir?: string
  worktrees?: string[]
  modules?: string[]
}): GitRepo {
  return {
    root: parts.root,
    gitDir: parts.gitDir,
    commonDir: parts.commonDir ?? parts.gitDir,
    worktreeGitDirs: parts.worktrees ?? [],
    moduleGitDirs: parts.modules ?? [],
  }
}

function buildRepo(root: string, gitDir: string): GitRepo {
  const cRoot = canonical(root)
  const cGitDir = canonical(gitDir)
  const commonDir = canonical(readCommonDir(cGitDir))
  return {
    root: cRoot,
    gitDir: cGitDir,
    commonDir,
    worktreeGitDirs: listDirs(join(commonDir, "worktrees")).map(canonical),
    moduleGitDirs: collectModules(join(commonDir, "modules")).map(canonical),
  }
}

function readCommonDir(gitDir: string): string {
  try {
    return resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
  } catch {
    return gitDir
  }
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(dir, d.name))
  } catch {
    return []
  }
}

function collectModules(modulesDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    for (const child of listDirs(dir)) {
      if (existsSync(join(child, "config"))) {
        // a real module gitdir; nested submodules live under it
        out.push(child)
        walk(join(child, "modules"), depth + 1)
      } else {
        // namespace directory (submodules with slash names nest, e.g. modules/vendor/sub)
        walk(child, depth + 1)
      }
    }
  }
  walk(modulesDir, 0)
  return out
}

// ---- protected-path classification -------------------------------------------

export type ProtectionKind = "metadata" | "hooks" | "sample" | "user"

export function normPath(p: string): string {
  const s = p.replace(/\\/g, "/")
  // drive-letter paths are absolute on every platform for our purposes —
  // POSIX path.resolve() would mangle them relative to cwd (fixture stability)
  const absolute = /^(?:[a-z]:\/|\/|\/\/|\\\\)/i.test(s)
  const resolved = absolute ? s : resolve(s).replace(/\\/g, "/")
  return resolved.toLowerCase().replace(/\/+$/, "")
}

function insideDir(p: string, dir: string): boolean {
  const d = normPath(dir)
  return p === d || p.startsWith(d + "/")
}

function allGitDirs(repo: GitRepo): string[] {
  return [repo.gitDir, repo.commonDir, ...repo.worktreeGitDirs, ...repo.moduleGitDirs]
}

function hooksDirs(repo: GitRepo): string[] {
  return [repo.commonDir, ...repo.moduleGitDirs].map((g) => join(g, "hooks"))
}

/** Absolute if drive/UNC/rooted; otherwise resolved against the repo root. */
function resolveArg(raw: string, repo: GitRepo): string {
  const s = raw.replace(/\\/g, "/")
  if (/^(?:[a-z]:\/|\/|\\\\|\/\/)/i.test(s)) return raw
  return join(repo.root, raw)
}

/**
 * Precise protected-path classification:
 *   <gitdir>/config* · worktree/module config* · <commondir>/hooks/** (and
 *   module hooks) · `.git` pointer files (repo root + submodule pointers) ·
 *   user protectPaths globs (worktree-relative). Relative inputs resolve
 *   against the repo root; hook-dir hits on `*.sample` return "sample".
 */
export function classifyProtectedPath(absPath: string, repo: GitRepo, userPatterns?: string[]): ProtectionKind | null {
  const p = normPath(resolveArg(absPath, repo))
  const base = p.slice(p.lastIndexOf("/") + 1)

  for (const dir of allGitDirs(repo)) {
    const d = normPath(dir)
    if (p.startsWith(d + "/") && base.startsWith("config")) return "metadata"
  }
  for (const hooks of hooksDirs(repo)) {
    if (insideDir(p, hooks)) return base.endsWith(".sample") ? "sample" : "hooks"
  }
  // `.git` pointer files: the repo root's own pointer when it is a file, and
  // any `<within-root>/**/.git` file (submodule pointers)
  if (base === ".git" && insideDir(p, repo.root)) {
    try {
      if (statSync(resolveArg(absPath, repo)).isFile()) return "metadata"
    } catch {
      // does not exist (creation attempt) — treat file-shaped `.git` paths as pointers
      return "metadata"
    }
  }
  if (userPatterns?.length) {
    const root = normPath(repo.root)
    const rel = p === root ? "" : p.replace(root + "/", "")
    for (const pattern of userPatterns) {
      if (matchPattern(rel, pattern)) return "user"
    }
  }
  return null
}

/**
 * Destructive-op rule: deleting/moving/truncating *anything inside any gitdir*
 * is fatal to integrity (index, HEAD, refs, objects) — broader than the write
 * roots, which stay precise to avoid noise on transient files.
 */
export function isInsideGitDir(absPath: string, repo: GitRepo): boolean {
  const p = normPath(resolveArg(absPath, repo))
  return allGitDirs(repo).some((d) => insideDir(p, d))
}

/** OpenCode-Wildcard-style pattern match on a normalized relative path. */
export function matchPattern(relNormalized: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .replace(/\\/g, "/")
        .toLowerCase()
        .replace(/[.+^${}()|[\]?]/g, (c) => "\\" + c)
        .replace(/\*/g, ".*") +
      "$",
)
  return re.test(relNormalized)
}
