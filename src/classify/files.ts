// File-impact analysis: every mutation channel folds into the
// protected-path evaluator — shell file-ops (coreutils + common PS cmdlets +
// cmd builtins + redirect targets) and the edit/write/patch tools.
//
// Two rules, deliberately split:
//   WRITE ops (>, tee, sed -i, cp-dest, chmod, Set-Content…) → precise roots:
//     config* · hooks/** (`.sample` inert) · `.git` pointer files · user protectPaths
//   DESTRUCTIVE ops (rm, mv, del, Remove-Item, truncate…) → anything inside a
//     gitdir is fatal (index/HEAD/refs/objects), minus a transient allowlist
//     (index.lock, COMMIT_EDITMSG, *.swp, …) so `rm .git/index.lock` stays legal.

import { Finding, Leaf } from "../types.js"
import { GitRepo, classifyProtectedPath, isInsideGitDir, normPath } from "../repo.js"
import { GuardConfig } from "../config.js"
import type { ClassifierDeps } from "./shell.js"

function guardFinding(rawPath: string, via: string): Finding {
  return {
    invariantId: "guard.self-protected",
    level: "deny",
    evidence: `\`${via}\` targets the git-integrity guard itself (\`${rawPath}\`)`,
    fixHint: "The guard cannot be modified from agent tool calls; ask the user.",
  }
}

/** True when the path is inside/equals one of the guard's own paths. */
export function hitsGuardPath(absPath: string, guardPaths?: string[], repo?: GitRepo): boolean {
  if (!guardPaths?.length) return false
  const resolved =
    repo && !/^(?:[a-z]:|\/|\\\\)/i.test(absPath.replace(/\\/g, "/"))
      ? `${normPath(repo.root)}/${absPath.replace(/\\/g, "/")}`
      : absPath
  const p = normPath(resolved)
  return guardPaths.some((g) => {
    const gp = normPath(g)
    return p === gp || p.startsWith(gp + "/")
  })
}

const DESTRUCTIVE = new Set(["rm", "del", "erase", "mv", "ren", "rename", "truncate", "remove-item", "ri", "move-item", "mi", "clear-content"])
const TRANSIENT = [/^index\.lock$/, /^commit_editmsg$/, /\.lock$/, /\.swp$/, /\.tmp$/, /^merge_msg$/, /^squash_msg$/, /^fetch_head$/, /^orig_head$/, /^auto_merge$/]

const PATH_FLAGS = new Set(["-path", "-literalpath", "-destination", "-filepath", "-target-directory", "-t", "--target-directory"])
const DATA_FLAGS = new Set(["-value", "-message"])

export function classifyFileImpact(leaf: Leaf, repo: GitRepo, cfg: GuardConfig, guardPaths?: string[]): Finding | undefined {
  const program = leaf.cmd.words[0]
  if (!program || program.dynamic) return undefined
  const name = program.value.replace(/\.exe$/i, "").replace(/\\/g, "/").split("/").pop()!.toLowerCase()
  const args = leaf.cmd.words.slice(1)

  if (DESTRUCTIVE.has(name)) {
    for (const p of [...positionals(args), ...flagValues(args)]) {
      const finding = destructiveFinding(p, repo, cfg, guardPaths)
      if (finding) return finding
    }
    return undefined
  }

  if (name === "tee" || name === "add-content") {
    return checkAll([...positionals(args), ...flagValues(args)], repo, cfg, guardPaths)
  }
  if (name === "set-content" || name === "sc" || name === "out-file") {
    const pos = positionals(args)
    const first = pos.slice(0, 1)
    return checkAll([...first, ...flagValues(args)], repo, cfg, guardPaths)
  }
  if (name === "dd") {
    const of = args.find((a) => !a.dynamic && /^of=/.test(a.value))
    return of ? checkAll([of.value.slice(3)], repo, cfg, guardPaths) : undefined
  }
  if (name === "cp" || name === "copy" || name === "copy-item") {
    const pos = positionals(args)
    const dest = [pos[pos.length - 1], ...flagValues(args)].filter(Boolean)
    return checkAll(dest, repo, cfg, guardPaths)
  }
  if (name === "sed") {
    const inPlace = args.some((a) => !a.dynamic && (/^-i/.test(a.value) || a.value === "--in-place" || a.value.startsWith("--in-place=")))
    if (!inPlace) return undefined
    return checkAll(positionals(args).slice(1), repo, cfg, guardPaths)
  }
  if (name === "chmod") {
    return chmodFinding(args, repo, cfg, guardPaths)
  }

  // redirect write targets (op contains ">" and is not a pure input redirect)
  for (const r of leaf.cmd.redirects) {
    if (!r.op.includes(">") || r.op === "<" || r.op === "<&") continue
    const finding = writeFinding(r.target.value, repo, cfg, `redirect \`${r.op}\``, guardPaths)
    if (finding) return finding
  }
  return undefined
}

function positionals(args: Leaf["cmd"]["words"]): string[] {
  return args.filter((a) => !a.dynamic && a.value !== "" && !a.value.startsWith("-")).map((a) => a.value)
}

function flagValues(args: Leaf["cmd"]["words"]): string[] {
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.dynamic || !PATH_FLAGS.has(a.value.toLowerCase())) continue
    if (DATA_FLAGS.has(a.value.toLowerCase())) continue
    const v = args[i + 1]
    if (v && !v.dynamic && !v.value.startsWith("-")) out.push(v.value)
    i++
  }
  return out
}

function destructiveFinding(rawPath: string, repo: GitRepo, cfg: GuardConfig, guardPaths?: string[]): Finding | undefined {
  const p = normPath(rawPath)
  if (hitsGuardPath(rawPath, guardPaths, repo)) return guardFinding(rawPath, "delete")
  if (!isInsideGitDir(rawPath, repo)) {
    // deleting the repo-root `.git` pointer file itself (linked worktree)
    const base = p.slice(p.lastIndexOf("/") + 1)
    if (base === ".git" && classifyProtectedPath(rawPath, repo) === "metadata") {
      return metadataFinding(rawPath, "delete", "`.git` gitdir pointer file")
    }
    return undefined
  }
  if (TRANSIENT.some((re) => re.test(p.slice(p.lastIndexOf("/") + 1)))) return undefined
  const kind = classifyProtectedPath(rawPath, repo)
  if (kind === "hooks" || (kind === "sample" && cfg.protectSampleHooks)) return hooksFinding(rawPath, "delete")
  if (kind === "sample") return undefined
  return metadataFinding(rawPath, "delete", "path inside the git directory")
}

function checkAll(paths: string[], repo: GitRepo, cfg: GuardConfig, guardPaths?: string[]): Finding | undefined {
  for (const p of paths) {
    const finding = writeFinding(p, repo, cfg, "write", guardPaths)
    if (finding) return finding
  }
  return undefined
}

export function writeFinding(rawPath: string, repo: GitRepo, cfg: GuardConfig, via: string, guardPaths?: string[]): Finding | undefined {
  if (hitsGuardPath(rawPath, guardPaths, repo)) return guardFinding(rawPath, via)
  const kind = classifyProtectedPath(rawPath, repo, cfg.protectPaths)
  if (kind === null) return undefined
  if (kind === "sample" && !cfg.protectSampleHooks) return undefined
  if (kind === "hooks" || (kind === "sample" && cfg.protectSampleHooks)) return hooksFinding(rawPath, via)
  return metadataFinding(rawPath, via, kind === "user" ? "matches protected path patterns" : "git metadata file")
}

function hooksFinding(rawPath: string, via: string): Finding {
  return {
    invariantId: "hooks.files.protected",
    level: "deny",
    evidence: `\`${via}\` targets repository hook \`${rawPath}\``,
    fixHint: "Never modify repository hooks; fix or configure them deliberately with the user.",
  }
}

function metadataFinding(rawPath: string, via: string, what: string): Finding {
  return {
    invariantId: "git.metadata.protected",
    level: "deny",
    evidence: `\`${via}\` targets ${what} (\`${rawPath}\`)`,
    fixHint: "Never modify Git control files; use git commands or ask the user.",
  }
}

function chmodFinding(args: Leaf["cmd"]["words"], repo: GitRepo, cfg: GuardConfig): Finding | undefined {
  // chmod's first non-flag operand is the MODE, which itself may look like a
  // flag (`-x`); strip known chmod flags, then split mode from paths.
  const CHMOD_FLAGS = new Set(["-r", "-f", "-v", "-c", "--recursive", "--changes", "--silent", "--quiet", "--verbose", "--preserve-root", "--no-preserve-root"])
  const operands = args.filter((a) => !a.dynamic && !(a.value.startsWith("-") && (CHMOD_FLAGS.has(a.value.toLowerCase()) || a.value.startsWith("--reference="))))
  const mode = operands[0]?.value
  if (!mode) return undefined
  const weakening =
    mode.includes("-x") ||
    (/^[0-7]{3,4}$/.test(mode) && !/[1357]/.test(mode.slice(-3))) // octal with no exec bits
  if (!weakening) return undefined
  for (const target of operands.slice(1)) {
    if (target.value.startsWith("-")) continue
    const kind = classifyProtectedPath(target.value, repo)
    if (kind === "hooks" || (kind === "sample" && cfg.protectSampleHooks)) return hooksFinding(target.value, `chmod ${mode}`)
    if (kind === "metadata") return metadataFinding(target.value, `chmod ${mode}`, "git metadata file")
    if (isInsideGitDir(target.value, repo)) return metadataFinding(target.value, `chmod ${mode}`, "path inside the git directory")
  }
  return undefined
}

/** edit/write/patch tool resources: worktree-relative, forward-slash (verified empirically). */
export function classifyEditResource(resource: string, repo: GitRepo, cfg: GuardConfig, guardPaths?: string[]): Finding | undefined {
  const rel = resource.replace(/\\/g, "/")
  const abs = /^(?:[a-z]:|\/|\\\\)/i.test(rel) ? rel : `${normPath(repo.root)}/${rel}`
  return writeFinding(abs, repo, cfg, "file edit", guardPaths)
}


