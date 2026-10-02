// Invariant evaluators. A single GitInvocation + its env
// analysis feed table-driven checks; every equivalent weakening form of an
// invariant produces the same finding. Evidence is token-precise.

import { ConfigDelta, Finding, GitInvocation } from "../types.js"
import { resolve } from "node:path"
import { gitBool } from "../git/booleans.js"
import { RepoState, commitSigningEnabled, tagSigningEnabled, pushSigningEnabled, hooksPathCurrent, protectedFromOrigin } from "../state.js"
import { normPath } from "../repo.js"
import { EnvAnalysis } from "./env.js"
import { MANAGER_ENV_RULES, managerEnvFinding } from "./managers.js"
import type { ClassifierDeps } from "./shell.js"

const HOOK_FLAG_BYPASS: Array<{ subs: string[]; flags: string[]; invariant: string }> = [
  { subs: ["commit", "am"], flags: ["--no-verify", "-n"], invariant: "commit.hooks.must-run" },
  { subs: ["merge", "pull"], flags: ["--no-verify"], invariant: "commit.hooks.must-run" },
  { subs: ["push"], flags: ["--no-verify"], invariant: "push.hooks.must-run" },
]

const SIGN_FLAG_BYPASS: Array<{ subs: string[]; flags: string[]; invariant: string; level: "ask" | "deny"; gate: (st: RepoState) => boolean }> = [
  { subs: ["commit", "am", "merge"], flags: ["--no-gpg-sign"], invariant: "commit.signing.must-stay-enabled", level: "deny", gate: commitSigningEnabled },
  { subs: ["tag"], flags: ["--no-sign"], invariant: "tag.signing.must-stay-enabled", level: "ask", gate: tagSigningEnabled },
  { subs: ["push"], flags: ["--signed=false", "--no-signed"], invariant: "push.signing.must-stay-enabled", level: "ask", gate: pushSigningEnabled },
]

const SIGN_OFF_KEYS: Record<string, string> = {
  "commit.gpgsign": "commit.signing.must-stay-enabled",
  "tag.gpgsign": "tag.signing.must-stay-enabled",
  "push.gpgsign": "push.signing.must-stay-enabled",
}

const HOOK_ENABLED_KEY = /^hook\.[^.]+\.enabled$/
const HK_SKIP_KEY = /^hk\.skip(steps|hooks|step|hook)$/

/** Plumbing that creates commits/refs without hooks — ask-level. */
const PLUMBING_SUBS = new Set(["commit-tree", "update-ref", "fast-import"])

const PROTECTED_SUBS = new Set(["commit", "am", "merge", "pull", "push", "tag"])

/** Session-start effective-state snapshot for drift detection. */
export type DriftSnapshot = {
  commitSigning: boolean
  tagSigning: boolean
  pushSigning: boolean
  hooksPath?: string
}

export function takeSnapshot(st: RepoState): DriftSnapshot {
  return {
    commitSigning: commitSigningEnabled(st),
    tagSigning: tagSigningEnabled(st),
    pushSigning: pushSigningEnabled(st),
    hooksPath: hooksPathCurrent(st),
  }
}

/** Values that make core.hooksPath mean "no hooks" (verified empirically). */
function nullHooksTarget(value: string): boolean {
  const v = value.trim().toLowerCase()
  return v === "" || v === "/dev/null" || v === "nul" || v === "\\\\.\\nul"
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function sameGitDir(given: string, st: RepoState): boolean {
  // resolve relative --git-dir against the repo root; drive-letter roots
  // (test fixtures) join lexically — POSIX path.resolve would mangle them
  const root = st.root ?? "."
  const g = /^(?:[a-z]:[\\/]|\/|\\\\)/i.test(given)
    ? given
    : /^(?:[a-z]:[\\/])/i.test(root)
      ? root.replace(/[\\/]+$/, "") + "/" + given
      : resolve(root, given)
  return samePath(normPath(g), normPath(st.gitDir!))
}

export function evaluateGit(
  gi: GitInvocation,
  env: EnvAnalysis,
  leafEnv: Record<string, string>,
  leafEnvDynamic: string[],
  deps: ClassifierDeps,
): Finding[] {
  const findings: Finding[] = []
  const st = deps.st
  const sub = gi.subcommand

  // scope shift: --git-dir pointing outside the session repo (§4.1 🟡)
  if (gi.globalOpts.gitDir && st.gitDir && !sameGitDir(gi.globalOpts.gitDir, st)) {
    findings.push(scopeShiftFinding(`--git-dir=${gi.globalOpts.gitDir} differs from session gitdir ${st.gitDir}`))
  }
  // env-driven scope shift: GIT_DIR family pointing elsewhere (§4.4 🟡)
  for (const scope of env.scope) {
    if (scope.name === "GIT_DIR" || scope.name === "GIT_COMMON_DIR") {
      if (st.gitDir && !sameGitDir(scope.value, st)) {
        findings.push(scopeShiftFinding(`env \`${scope.name}=${scope.value}\` differs from session gitdir ${st.gitDir}`))
      }
    } else if (scope.name === "GIT_WORK_TREE") {
      if (st.root && !samePath(resolve(st.root, scope.value), st.root)) {
        findings.push(scopeShiftFinding(`env \`GIT_WORK_TREE=${scope.value}\` differs from the session worktree ${st.root}`))
      }
    } else {
      // GIT_OBJECT_DIRECTORY / GIT_INDEX_FILE redirect core paths — exotic in agent hands
      findings.push(scopeShiftFinding(`env \`${scope.name}\` redirects git's ${scope.name === "GIT_INDEX_FILE" ? "index" : "object directory"}`))
    }
  }

  // hook-bypass flags (position-sensitive: only on their subcommands)
  for (const row of HOOK_FLAG_BYPASS) {
    if (!row.subs.includes(sub)) continue
    const hit = row.flags.find((f) => gi.flags.includes(f))
    if (hit) {
      findings.push({
        invariantId: row.invariant,
        level: "deny",
        evidence: `\`${abbrev(gi)}\` → flag \`${hit}\` on subcommand \`${sub}\``,
        fixHint: "Fix the failing hook or repository state rather than bypassing it.",
      })
    }
  }

  // signing-bypass flags, gated on effective signing
  for (const row of SIGN_FLAG_BYPASS) {
    if (!row.subs.includes(sub)) continue
    const hit = row.flags.find((f) => gi.flags.includes(f))
    if (hit && row.gate(st)) {
      findings.push({
        invariantId: row.invariant,
        level: row.level,
        evidence: `\`${abbrev(gi)}\` → flag \`${hit}\` on subcommand \`${sub}\` disables configured signing`,
        fixHint: "Keep signing enabled; configure a signing key if commits must be signed.",
      })
    }
  }

  // suspicious plumbing (§4.7) — legitimate tooling uses these; ask-level
  if (PLUMBING_SUBS.has(sub)) {
    findings.push({
      invariantId: "plumbing.suspicious",
      level: "ask",
      evidence: `\`${abbrev(gi)}\` creates commits/refs through plumbing (hooks do not run)`,
      fixHint: "Use porcelain (commit/tag) so repository hooks run.",
    })
  }
  if (sub === "hash-object" && gi.flags.includes("-w")) {
    findings.push({
      invariantId: "plumbing.suspicious",
      level: "ask",
      evidence: "`git hash-object -w` writes objects outside normal commit flow",
      fixHint: "Use porcelain so repository hooks run.",
    })
  }

  // hook-manager env coupling (§4.5) — only with the manager in use + a
  // protected subcommand in the same invocation
  if (PROTECTED_SUBS.has(sub)) {
    for (const candidate of env.manager) {
      const finding = managerEnvFinding(candidate.rule, candidate.value, deps.managers?.has(candidate.rule.manager) ?? false)
      if (finding) findings.push(finding)
    }
    if (env.hkFile !== undefined && (deps.managers?.has("hk") ?? false)) {
      if (nullHooksTarget(env.hkFile)) {
        findings.push({
          invariantId: "signing.config.frozen",
          level: "deny",
          evidence: `\`HK_FILE=${env.hkFile}\` points hk at a null target — its checks silently vanish for this invocation`,
          fixHint: "Don't hide configuration sources; work with the repository's real settings.",
        })
      } else {
        findings.push({
          invariantId: "hooks.config.frozen",
          level: "ask",
          evidence: `\`HK_FILE=${env.hkFile}\` substitutes hk's config source for this invocation`,
          fixHint: "Only substitute hk's config deliberately, with the user aware.",
        })
      }
    }
  }

  // config deltas from every channel: -c, --config-env, env injection
  const deltas: Array<{ delta: ConfigDelta; origin: string }> = []
  for (const d of gi.globalOpts.config) deltas.push({ delta: d, origin: "`-c`" })
  for (const d of gi.globalOpts.configEnv) {
    const resolved = d.envName !== undefined ? leafEnv[d.envName] : undefined
    const isDynamic = d.envName !== undefined && leafEnvDynamic.includes(d.envName)
    deltas.push({
      delta: resolved !== undefined && !isDynamic ? { ...d, value: resolved, channel: "configEnv" } : d,
      origin:
        resolved !== undefined && !isDynamic
          ? `\`--config-env=${d.key}=${d.envName}\` → \`${resolved}\``
          : `\`--config-env=${d.key}=${d.envName}\` (value not statically resolvable)`,
    })
  }
  for (const d of env.deltas) deltas.push({ delta: d, origin: envOrigin(d) })
  findings.push(...evaluateDeltas(deltas, st))

  // malformed GIT_CONFIG_PARAMETERS is itself suspicious (git hard-errors)
  if (env.malformedParameters) {
    findings.push({
      invariantId: "hooks.config.frozen",
      level: "deny",
      evidence: `\`GIT_CONFIG_PARAMETERS=${env.malformedParameters}\` does not match git's quoted grammar (git rejects it)`,
      fixHint: "Use the documented `'key=value'` form — or don't inject config at all.",
    })
  }
  for (const name of env.unresolved) {
    findings.push({
      invariantId: "hooks.config.frozen",
      level: "ask",
      evidence: `env \`${name}\` has a dynamically computed value in a git invocation`,
      fixHint: "Pass configuration values literally.",
    })
  }

  // config-source hiding, gated on whether that origin currently provides
  // protected keys
  for (const h of env.hiding) {
    const originTag = h.name === "GIT_CONFIG_NOSYSTEM" || h.name === "GIT_CONFIG_SYSTEM" ? "system" : "global"
    if (protectedFromOrigin(st, originTag)) {
      findings.push({
        invariantId: "signing.config.frozen",
        level: "deny",
        evidence: `\`${h.name}=${h.value}\` hides the ${originTag} config that currently provides signing/hook settings`,
        fixHint: "Don't hide configuration sources; work with the repository's real settings.",
      })
    }
  }

  // drift: effective state weakened since session start (§5.4) — second line
  // of defense for channels we didn't see
  if (deps.snapshot && PROTECTED_SUBS.has(sub)) {
    const drift = driftFindings(deps.snapshot, st)
    if (drift) {
      if (deps.expectedDrift) {
        deps.expectedDrift = false
        deps.snapshot = takeSnapshot(st)
      } else {
        findings.push(...drift)
      }
    }
  }

  // dynamically computed arguments on a protected subcommand
  if (gi.hasDynamicArg && PROTECTED_SUBS.has(sub)) {
    findings.push({
      invariantId: "x-dynamic-argument",
      level: "ask",
      evidence: `\`${abbrev(gi)}\` passes a dynamically computed argument to \`${sub}\` — flags cannot be verified`,
      fixHint: "Spell the command out literally so it can be checked.",
    })
  }

  return findings
}

function driftFindings(snapshot: DriftSnapshot, st: RepoState): Finding[] | null {
  const now = takeSnapshot(st)
  const findings: Finding[] = []
  if (snapshot.commitSigning && !now.commitSigning) {
    findings.push({
      invariantId: "signing.config.frozen",
      level: "deny",
      evidence: "commit signing was effectively enabled at session start and has since disappeared",
      fixHint: "Restore the signing configuration; mid-session weakening is not permitted.",
    })
  }
  if (snapshot.tagSigning && !now.tagSigning) {
    findings.push({
      invariantId: "signing.config.frozen",
      level: "deny",
      evidence: "tag signing was effectively configured at session start and has since disappeared",
      fixHint: "Restore the signing configuration; mid-session weakening is not permitted.",
    })
  }
  const hadHooks = snapshot.hooksPath !== undefined && snapshot.hooksPath !== ""
  const hasHooks = now.hooksPath !== undefined && now.hooksPath !== ""
  if (hadHooks && (!hasHooks || !samePath(snapshot.hooksPath!, now.hooksPath!))) {
    findings.push({
      invariantId: "hooks.config.frozen",
      level: "deny",
      evidence: `\`core.hooksPath\` was \`${snapshot.hooksPath}\` at session start and is now \`${now.hooksPath ?? "unset"}\``,
      fixHint: "Restore the hooks configuration; mid-session weakening is not permitted.",
    })
  }
  return findings.length > 0 ? findings : null
}

function scopeShiftFinding(evidence: string): Finding {
  return {
    invariantId: "git.scope.shift",
    level: "ask",
    evidence,
    fixHint: "Run git against the repository you were asked to work on.",
  }
}

/** Shared delta evaluator for every config-mutation channel (§5.4). */
export function evaluateDeltas(deltas: Array<{ delta: ConfigDelta; origin: string }>, st: RepoState): Finding[] {
  const findings: Finding[] = []
  for (const { delta, origin } of deltas) {
    if (delta.key === "") continue
    const keyIsProtected =
      SIGN_OFF_KEYS[delta.key] !== undefined || HOOK_ENABLED_KEY.test(delta.key) || delta.key === "core.hookspath" || HK_SKIP_KEY.test(delta.key)

    if (delta.unset) {
      // weakening only when the key currently provides the protected setting
      const signInvariant = SIGN_OFF_KEYS[delta.key]
      if (signInvariant) {
        const gate =
          signInvariant === "commit.signing.must-stay-enabled"
            ? commitSigningEnabled(st)
            : signInvariant === "tag.signing.must-stay-enabled"
              ? tagSigningEnabled(st)
              : pushSigningEnabled(st)
        if (gate) {
          findings.push({
            invariantId: signInvariant,
            level: "deny",
            evidence: `${origin}: unsets \`${delta.key}\` while it is effectively enabling signing`,
            fixHint: "Keep signing enabled; ask the user if signing genuinely must change.",
          })
        }
        continue
      }
      if (delta.key === "core.hookspath") {
        const current = hooksPathCurrent(st)
        if (current !== undefined && current !== "") {
          findings.push({
            invariantId: "hooks.config.frozen",
            level: "deny",
            evidence: `${origin}: unsets \`core.hooksPath\` (currently \`${current}\`) — the repo's hooks silently stop running`,
            fixHint: "Keep the repository's hooks configuration in place.",
          })
        }
        continue
      }
      if (HOOK_ENABLED_KEY.test(delta.key)) {
        // unset of a config-hook enable flag: only meaningful if currently true
        continue
      }
      continue
    }

    if (delta.value === null) {
      if (keyIsProtected) {
        findings.push({
          invariantId: "hooks.config.frozen",
          level: "ask",
          evidence: `${origin}: dynamic/unresolved value for protected key \`${delta.key}\``,
          fixHint: "Pass configuration values literally.",
        })
      }
      continue
    }

    const signInvariant = SIGN_OFF_KEYS[delta.key]
    if (signInvariant) {
      const b = gitBool(delta.value)
      if (b === false) {
        const gate =
          signInvariant === "commit.signing.must-stay-enabled"
            ? commitSigningEnabled(st)
            : signInvariant === "tag.signing.must-stay-enabled"
              ? tagSigningEnabled(st)
              : pushSigningEnabled(st)
        if (gate) {
          findings.push({
            invariantId: signInvariant,
            level: "deny",
            evidence: `${origin}: sets \`${delta.key}\` falsy while signing is effectively enabled`,
            fixHint: "Keep signing enabled; ask the user if signing genuinely must change.",
          })
        }
      }
      // truthy → strengthening; unparseable → git rejects the command
      continue
    }
    if (HOOK_ENABLED_KEY.test(delta.key)) {
      const b = gitBool(delta.value)
      if (b === false) {
        findings.push({
          invariantId: "hooks.config.frozen",
          level: "deny",
          evidence: `${origin}: disables config-based hook via \`${delta.key}=${typeof delta.value === "string" ? delta.value : delta.value}\``,
          fixHint: "Keep hooks enabled; fix the failing hook instead.",
        })
      }
      continue
    }
    if (HK_SKIP_KEY.test(delta.key)) {
      if (delta.value !== "") {
        findings.push({
          invariantId: "hooks.config.frozen",
          level: "deny",
          evidence: `${origin}: sets \`${delta.key}=${delta.value}\` — hk skips the named hooks/steps`,
          fixHint: "Keep hooks enabled; fix the failing step instead.",
        })
      }
      continue
    }
    if (delta.key === "core.hookspath") {
      const value = delta.value === true ? "" : String(delta.value)
      if (nullHooksTarget(value)) {
        findings.push({
          invariantId: "hooks.config.frozen",
          level: "deny",
          evidence: `${origin}: points \`core.hooksPath\` at null target \`${value || "∅"}\` (hooks silently skipped)`,
          fixHint: "Keep the repository's hooks directory in place.",
        })
      } else {
        const current = hooksPathCurrent(st)
        if (current === undefined || !samePath(current, value)) {
          findings.push({
            invariantId: "hooks.config.frozen",
            level: "ask",
            evidence: `${origin}: repoints \`core.hooksPath\` to \`${value}\` (currently \`${current ?? "unset"}\`)`,
            fixHint: "Only change the hooks directory deliberately, with the user aware.",
          })
        }
      }
      continue
    }
    // gpg.format etc. — future versions
  }
  return findings
}

function envOrigin(d: ConfigDelta): string {
  if (d.channel === "envGitConfig") return `\`GIT_CONFIG_COUNT\` injection of \`${d.key}\``
  if (d.channel === "configParameters") return `\`GIT_CONFIG_PARAMETERS\` injection of \`${d.key}\``
  if (d.channel === "configSub") return `\`git config\` (\`${d.scope ?? "local"}\`)`
  return `\`${d.key}\``
}

function abbrev(gi: GitInvocation): string {
  return gi.raw.length > 72 ? gi.raw.slice(0, 69) + "…" : gi.raw
}
