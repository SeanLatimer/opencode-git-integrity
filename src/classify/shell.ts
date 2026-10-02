// Shell-resource classifier: resource strings (permission-evaluate resources
// are per-command source text, verified at runtime) → parse → unwrap → git IR →
// invariant findings. Fail-mode posture: a resource that confidently invokes
// git but cannot be parsed is denied when failMode=closed.

import { Finding, GitInvocation, ParseError, SimpleCommand } from "../types.js"
import { lex } from "../parse/lexer.js"
import { buildCommands } from "../parse/commands.js"
import { parsePowerShell } from "../parse/powershell.js"
import { parseCmd } from "../parse/cmd.js"
import { Leaf, unwrapAll } from "../parse/unwrap.js"
import { parseGitInvocation } from "../git/argv.js"
import { analyzeEnv } from "./env.js"
import { evaluateGit, evaluateDeltas } from "./invariants.js"
import { classifyFileImpact } from "./files.js"
import { hkCommandFindings, ManagerName } from "./managers.js"
import { parseConfigSubcommand, configActionToDeltas } from "../git/configSub.js"
import { RepoState } from "../state.js"
import { GitRepo } from "../repo.js"
import { applyPolicy } from "../policy.js"
import type { GuardConfig } from "../config.js"
import type { DriftSnapshot } from "./invariants.js"

export type ClassifierDeps = {
  cfg: GuardConfig
  st: RepoState
  repo: GitRepo
  /** Hook managers detected in this repo . */
  managers?: Set<ManagerName>
  /** git aliases from repo+global config. */
  aliases?: Record<string, string>
  /** Session-start effective-state snapshot for drift. */
  snapshot?: DriftSnapshot
  /** Set when an allowed `git config` mutation should refresh, not trip, drift. */
  expectedDrift?: boolean
  /** Guard's own install dir + config files — protected paths . */
  guardPaths?: string[]
}

export type Decision = { decision: "allow" | "ask" | "deny"; finding?: Finding }

const GIT_TOKEN = /\bgit\b|\bgit\.exe\b/
const MAX_SUB_DEPTH = 4
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

export type Dialect = "posix" | "pwsh" | "cmd"

const WINDOWS = process.platform === "win32"

/** Dialect preference: strong markers win, else platform default. */
export function dialectChain(resource: string): Dialect[] {
  if (/\$env:[A-Za-z_]/.test(resource)) return ["pwsh", "posix"]
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(resource)) return ["cmd", "pwsh", "posix"]
  return WINDOWS ? ["pwsh", "posix"] : ["posix", "pwsh"]
}

export function parseDialect(resource: string, dialect: Dialect): SimpleCommand[] {
  if (dialect === "pwsh") return parsePowerShell(resource)
  if (dialect === "cmd") return parseCmd(resource)
  return buildCommands(lex(resource))
}

/** Parses with the dialect chain; throws the first ParseError if none parse. */
function parseAuto(resource: string): SimpleCommand[] {
  let firstError: ParseError | undefined
  for (const dialect of dialectChain(resource)) {
    try {
      return parseDialect(resource, dialect)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      firstError ??= error
    }
  }
  throw firstError ?? new ParseError("unparseable")
}

/** Classifies every resource of one shell tool call. */
export function classifyResources(resources: string[], deps: ClassifierDeps): Decision {
  let pendingAsk: Finding | undefined
  for (const resource of resources) {
    const result = classifyResource(resource, deps, {}, 0)
    if (result.decision === "deny") return result
    if (result.decision === "ask" && !pendingAsk) pendingAsk = result.finding
  }
  return pendingAsk ? { decision: "ask", finding: pendingAsk } : { decision: "allow" }
}

const MONITORED_LONG_FLAGS = ["--no-verify", "--no-gpg-sign", "--no-sign", "--no-signed", "--signed=false"]

const SUSPICIOUS_PARSE_REASONS = new Set([
  "invoke-expression",
  "ps-compound",
  "cmd-compound",
  "compound",
  "case-statement",
  "dynamic-script",
  "ps-scriptblock",
  "ps-here-string",
  "heredoc",
])

export function classifyResource(resource: string, deps: ClassifierDeps, extraEnv: Record<string, string>, depth: number): Decision {
  const findings: Finding[] = []
  let parsed = false
  let firstError: ParseError | undefined

  // Try every dialect that can parse and merge findings, most severe wins:
  // a bash env-prefix attack (`VAR=x git …`) must not be lost because the
  // PowerShell reading of the same string is benign, and vice versa.
  for (const dialect of dialectChain(resource)) {
    try {
      findings.push(...walkCommands(parseDialect(resource, dialect), resource, deps, extraEnv, depth))
      parsed = true
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      firstError ??= error
    }
  }

  if (!parsed) {
    if (deps.cfg.failMode === "closed" && GIT_TOKEN.test(resource)) {
      return {
        decision: "deny",
        finding: {
          invariantId: "parse.failed",
          level: "deny",
          evidence: `\`${abbrev(resource)}\` invokes git but could not be parsed (${firstError?.reason ?? "unparseable"})`,
          fixHint: "Use plain, literal git commands so the guard can verify them.",
        },
      }
    }
    return { decision: "allow" }
  }

  // One dialect rejected a git-looking resource while another parsed cleanly —
  // keep the fail-closed signal only for DELIBERATE opacity (dynamic execution,
  // compounds, hidden payloads), not mundane lexer quirks of the other dialect.
  if (firstError && deps.cfg.failMode === "closed" && GIT_TOKEN.test(resource) && SUSPICIOUS_PARSE_REASONS.has(firstError.reason)) {
    findings.push({
      invariantId: "parse.failed",
      level: "deny",
      evidence: `\`${abbrev(resource)}\` parses as ${firstError.reason} under one shell dialect — treated as unverified git invocation`,
      fixHint: "Use plain, literal git commands so the guard can verify them.",
    })
  }

  return pick(applyPolicy(findings, deps.cfg))
}

function walkCommands(
  commands: SimpleCommand[],
  resource: string,
  deps: ClassifierDeps,
  extraEnv: Record<string, string>,
  depth: number,
): Finding[] {
  const findings: Finding[] = []
  const carried: Record<string, string> = { ...extraEnv }
  const carriedDynamic: string[] = []
  for (const cmd of commands) {
    collectExport(cmd, carried, carriedDynamic)
    const cmdEnv = { ...carried }
    for (const a of cmd.assignments) {
      if (a.dynamic) carriedDynamic.push(a.name)
      else cmdEnv[a.name] = a.value
    }
    const leaves = unwrapAll(cmd, cmdEnv, carriedDynamic)
    for (const leaf of leaves) {
      // wrappers (cmd /c, pwsh -Command) emit export pseudo-commands as inner
      // leaves — fold them into the carried env before later leaves evaluate
      collectExport(leaf.cmd, carried, carriedDynamic)
      const expanded = depth < 5 ? expandAlias(leaf.cmd, deps) : leaf.cmd
      const gi = parseGitInvocation(expanded, expanded.raw)
      if (gi) {
        // env deltas only matter coupled to the git invocation itself
        const ea = analyzeEnv({ ...carried, ...leaf.env }, [...carriedDynamic, ...leaf.envDynamic])
        findings.push(...evaluateGit(gi, ea, { ...carried, ...leaf.env }, [...carriedDynamic, ...leaf.envDynamic], deps))
        // `git config` subcommand: persistent mutations
        if (gi.subcommand === "config") {
          findings.push(...configSubFindings(gi, deps, cmdEnv, depth))
        }
        // strict alias mode: unknown subcommand could be an alias we can't see (§5.2 #5)
        if (deps.cfg.strictAliases && !KNOWN_SUBCOMMANDS.has(gi.subcommand) && !(gi.subcommand in (deps.aliases ?? {}))) {
          findings.push({
            invariantId: "alias.unresolved",
            level: "ask",
            evidence: `\`git ${gi.subcommand}\` is not a known subcommand and no alias definition was found — it may be a locally-defined alias`,
            fixHint: "Use standard subcommands, or define the alias in tracked config.",
          })
        }
        continue
      }
      // non-git manager CLI: hk uninstall / install --global
      const program = leaf.cmd.words[0]
      if (program && !program.dynamic && program.value.toLowerCase().replace(/\.exe$/, "") === "hk") {
        findings.push(...hkCommandFindings(leaf.cmd))
        continue
      }
      // dynamically-computed program carrying monitored git flags — unverified
      const prog = leaf.cmd.words[0]
      if (prog?.dynamic && leaf.cmd.words.slice(1).some((w) => MONITORED_LONG_FLAGS.some((f) => w.value.includes(f)))) {
        findings.push({
          invariantId: "x-dynamic-argument",
          level: "ask",
          evidence: `\`${abbrev(leaf.cmd.raw)}\` runs a dynamically computed command with git-integrity flags in its arguments`,
          fixHint: "Spell the command out literally so it can be checked.",
        })
      }
      // non-git leaf: file-impact analysis on protected git control paths
      const fileFinding = classifyFileImpact(leaf, deps.repo, deps.cfg, deps.guardPaths)
      if (fileFinding) findings.push(fileFinding)
    }
    // substitutions run with this command's env — classify recursively
    if (depth < MAX_SUB_DEPTH) {
      for (const sub of cmd.substitutions) {
        const inner = classifyResource(sub, deps, cmdEnv, depth + 1)
        if (inner.finding) findings.push(inner.finding)
      }
    }
  }
  return findings
}

/** git alias expansion (§5.2 #5): `git <alias>` → alias words spliced in. */
function expandAlias(cmd: SimpleCommand, deps: ClassifierDeps): SimpleCommand {
  const aliases = deps.aliases
  if (!aliases || cmd.words.length < 2) return cmd
  const sub = cmd.words[1]
  if (sub.dynamic || sub.quoted) return cmd
  const expansion = aliases[sub.value]
  if (expansion === undefined) return cmd
  try {
    const aliasWords = buildCommands(lex(expansion))[0]?.words ?? []
    if (aliasWords.length === 0) return cmd
    return {
      ...cmd,
      words: [cmd.words[0], ...aliasWords, ...cmd.words.slice(2)],
      raw: `${cmd.raw} (alias \`${sub.value}\` → \`${expansion}\`)`,
    }
  } catch {
    return cmd
  }
}

/** `git config` mutation findings (§4.3): deltas via the shared evaluator;
 * alias creations classify their VALUE as a git command (violating expansions). */
function configSubFindings(gi: GitInvocation, deps: ClassifierDeps, cmdEnv: Record<string, string>, depth: number): Finding[] {
  const action = parseConfigSubcommand(gi)
  if (action.kind !== "set" && action.kind !== "unset") return []
  if (action.kind === "set" && action.key.startsWith("alias.")) {
    if (action.valueDynamic) {
      return [{
        invariantId: "hooks.config.frozen",
        level: "ask",
        evidence: `\`git config ${action.key}\` sets an alias to a dynamically computed command`,
        fixHint: "Define aliases literally so they can be checked.",
      }]
    }
    // alias values are git-subcommand fragments: classify `git <expansion>`
    const inner = classifyResource(`git ${action.value}`, deps, cmdEnv, depth + 1)
    if (inner.finding) {
      return [{
        ...inner.finding,
        evidence: `alias creation \`git config ${action.key} "${action.value}"\`: ${inner.finding.evidence}`,
      }]
    }
    return []
  }
  const deltas = configActionToDeltas(action)
  const findings = evaluateDeltas(
    deltas.map((delta) => ({ delta, origin: `\`git config\` (\`${action.scope}\`)` })),
    deps.st,
)
  // an allowed mutation becomes the new baseline for drift (§5.4)
  if (findings.length === 0) deps.expectedDrift = true
  return findings
}

/** Git subcommands we recognize (strict-alias mode treats others as possible aliases). */
const KNOWN_SUBCOMMANDS = new Set([
  "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file", "check-attr",
  "check-ignore", "check-mailmap", "check-ref-format", "checkout", "checkout-index", "cherry", "cherry-pick", "citool",
  "clean", "clone", "column", "commit", "commit-graph", "commit-tree", "config", "count-objects", "credential",
  "describe", "diff", "difftool", "env", "fast-export", "fast-import", "fetch", "filter-branch", "fmt-merge-msg",
  "for-each-ref", "format-patch", "fsck", "gc", "get-tar-commit-id", "grep", "gui", "hash-object", "help", "hook",
  "http-backend", "http-fetch", "http-push", "imap-send", "index-pack", "init", "instaweb", "interpret-trailers",
  "log", "ls-files", "ls-remote", "ls-tree", "mailinfo", "mailsplit", "merge", "merge-base", "merge-file",
  "merge-index", "merge-octopus", "merge-one-file", "merge-ours", "merge-recursive", "merge-resolve", "merge-tree",
  "mktag", "mktree", "multi-pack-index", "mv", "name-rev", "notes", "p4", "pack-objects", "pack-redundant",
  "pack-refs", "patch-id", "prune", "prune-packed", "pull", "push", "quiltimport", "range-diff", "read-tree",
  "rebase", "reflog", "refs", "remote", "repack", "replace", "request-pull", "rerere", "reset", "restore",
  "rev-list", "rev-parse", "revert", "rm", "send-email", "send-pack", "shell", "shortlog", "show", "show-branch",
  "show-index", "show-ref", "sparse-checkout", "stage", "stash", "status", "stripspace", "submodule", "switch",
  "symbolic-ref", "tag", "unpack-file", "unpack-objects", "update-index", "update-ref", "update-server-info",
  "upload-archive", "upload-pack", "var", "verify-commit", "verify-pack", "verify-tag", "version", "whatchanged",
  "worktree", "write-tree",
])

function collectExport(cmd: SimpleCommand, carried: Record<string, string>, carriedDynamic: string[]) {  const head = cmd.words[0]
  if (!head || head.dynamic || (head.value !== "export" && head.value !== "set")) return
  for (const w of cmd.words.slice(1)) {
    if (w.dynamic) {
      // dynamic value on an assignment-shaped word (PS/cmd parsers emit NAME= for unknowns)
      if (ASSIGN_RE.test(w.value)) carriedDynamic.push(w.value.slice(0, w.value.indexOf("=")))
      continue
    }
    if (!ASSIGN_RE.test(w.value)) continue
    const eq = w.value.indexOf("=")
    carried[w.value.slice(0, eq)] = w.value.slice(eq + 1)
  }
}

export function pick(findings: Finding[]): Decision {
  let deny: Finding | undefined
  let ask: Finding | undefined
  for (const f of findings) {
    if (f.level === "deny" && !deny) deny = f
    if (f.level === "ask" && !ask) ask = f
  }
  if (deny) return { decision: "deny", finding: deny }
  if (ask) return { decision: "ask", finding: ask }
  return { decision: "allow" }
}

function abbrev(text: string): string {
  return text.length > 72 ? text.slice(0, 69) + "…" : text
}
