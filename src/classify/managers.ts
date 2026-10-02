// Hook-manager escape hatches. Manager env vars matter only when
// coupled to a protected git subcommand in the same invocation AND the manager
// is in use in the repo (zero noise elsewhere). hk CLI commands (uninstall /
// install --global) are classified at the program level.

import { Finding, SimpleCommand } from "../types.js"
import { RepoState } from "../state.js"

export type ManagerName = "husky" | "lefthook" | "precommit" | "hk"

export type ManagerEnvRule = {
  manager: ManagerName
  /** Env var names; value semantics below. */
  name: string
  /** falsy-only (HUSKY/LEFTHOOK/HK) vs any-value (SKIP, lists, …). */
  any?: boolean
  /** truthy-only (PRE_COMMIT_ALLOW_NO_CONFIG). */
  truthy?: boolean
}

export const MANAGER_ENV_RULES: ManagerEnvRule[] = [
  { manager: "husky", name: "HUSKY" },
  { manager: "lefthook", name: "LEFTHOOK" },
  { manager: "lefthook", name: "LEFTHOOK_EXCLUDE", any: true },
  { manager: "precommit", name: "SKIP", any: true },
  { manager: "precommit", name: "PRE_COMMIT_ALLOW_NO_CONFIG", truthy: true },
  { manager: "hk", name: "HK" },
  { manager: "hk", name: "HK_SKIP_HOOK", any: true },
  { manager: "hk", name: "HK_SKIP_HOOKS", any: true },
  { manager: "hk", name: "HK_SKIP_STEPS", any: true },
  { manager: "hk", name: "HK_SKIP_STEP", any: true },
]

const FALSY = new Set(["", "0", "false", "no", "off"])

export function managerEnvFinding(rule: ManagerEnvRule, value: string, managerInUse: boolean): Finding | undefined {
  if (!managerInUse) return undefined
  const triggers = rule.any ? value !== "" : rule.truthy ? !FALSY.has(value.toLowerCase()) : FALSY.has(value.toLowerCase())
  if (!triggers) return undefined
  return {
    invariantId: "hookmanagers.must-run",
    level: "deny",
    evidence: `env \`${rule.name}=${value}\` disables the ${rule.manager} hooks for this invocation`,
    fixHint: "Fix the failing hook rather than disabling the manager.",
  }
}

/** Repo-scoped manager detection: files + config references. */
export function detectManagers(root: string | null, st: RepoState): Set<ManagerName> {
  const found = new Set<ManagerName>()
  const hooksPath = st.effective("core.hookspath")?.value?.toLowerCase() ?? ""
  const hookCommands = st
    .files()
    .flatMap((f) => Object.keys(f.entries))
    .filter((k) => k.startsWith("hook.") && (k.endsWith(".command") || k.endsWith(".path")))
    .join(" ")
    .toLowerCase()
  const mentions = (needle: string) => hooksPath.includes(needle) || hookCommands.includes(needle)

  const markers: Array<[ManagerName, string[], string]> = [
    ["husky", [".husky"], "husky"],
    ["lefthook", ["lefthook.yml", "lefthook.yaml", ".lefthook.yml"], "lefthook"],
    ["precommit", [".pre-commit-config.yaml", ".pre-commit-config.yml"], "pre-commit"],
    ["hk", ["hk.pkl", ".config/hk.pkl"], "hk"],
  ]
  for (const [name, files, needle] of markers) {
    if ((root && files.some((f) => st.exists(`${root}/${f}`))) || mentions(needle)) found.add(name)
  }
  return found
}

/** hk CLI commands: `hk uninstall` (ask), `hk install --global` (deny). */
export function hkCommandFindings(cmd: SimpleCommand): Finding[] {
  const sub = cmd.words[1]?.value?.toLowerCase()
  const findings: Finding[] = []
  if (sub === "uninstall") {
    findings.push({
      invariantId: "hookmanagers.must-run",
      level: "ask",
      evidence: "`hk uninstall` removes the repo's hook manager",
      fixHint: "Only uninstall hook managers deliberately, with the user aware.",
    })
  }
  if (sub === "install" && cmd.words.slice(2).some((w) => !w.dynamic && (w.value === "--global" || w.value === "-g"))) {
    findings.push({
      invariantId: "hookmanagers.must-run",
      level: "deny",
      evidence: "`hk install --global` installs machine-wide hooks that execute any repo's `hk.pkl` steps",
      fixHint: "Keep hook installs repo-scoped (plan: hooks per-repo, guard per-user).",
    })
  }
  return findings
}
