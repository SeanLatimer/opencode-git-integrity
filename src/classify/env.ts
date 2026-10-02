// Environment-injection deltas. Env assignments only matter when
// coupled to a git invocation in the same command — the caller evaluates these
// deltas against git leaves only.
//
// Covers :
//   GIT_CONFIG_COUNT + GIT_CONFIG_KEY_n + GIT_CONFIG_VALUE_n  (paired, indexed)
//   GIT_CONFIG_PARAMETERS  (git's sq-quoted grammar; malformed → suspicious)
//   GIT_CONFIG_GLOBAL / GIT_CONFIG_SYSTEM / GIT_CONFIG_NOSYSTEM  (config-source
//     hiding candidates — gated by effective-config origins in invariants.ts)

import { ConfigDelta } from "../types.js"
import { ManagerEnvRule, MANAGER_ENV_RULES } from "./managers.js"

export type HidingCandidate = { name: "GIT_CONFIG_GLOBAL" | "GIT_CONFIG_SYSTEM" | "GIT_CONFIG_NOSYSTEM"; value: string }

export type ScopeCandidate = { name: "GIT_DIR" | "GIT_COMMON_DIR" | "GIT_WORK_TREE" | "GIT_OBJECT_DIRECTORY" | "GIT_INDEX_FILE"; value: string }

export type EnvAnalysis = {
  deltas: ConfigDelta[]
  hiding: HidingCandidate[]
  /** Hook-manager escape-hatch vars present in this invocation's env (§4.5). */
  manager: Array<{ rule: ManagerEnvRule; value: string }>
  /** GIT_DIR family present (§4.4 🟡). */
  scope: ScopeCandidate[]
  /** HK_FILE substitution value, when set (§4.5). */
  hkFile?: string
  /** Dynamic (unresolvable) values for known injection channels. */
  unresolved: string[]
  /** GIT_CONFIG_PARAMETERS present but not parseable per git's grammar. */
  malformedParameters?: string
}

export function analyzeEnv(env: Record<string, string>, envDynamic: string[]): EnvAnalysis {
  const deltas: ConfigDelta[] = []
  const hiding: HidingCandidate[] = []
  const manager: Array<{ rule: ManagerEnvRule; value: string }> = []
  const scope: ScopeCandidate[] = []
  const unresolved: string[] = []
  let malformedParameters: string | undefined

  for (const name of envDynamic) {
    if (name === "GIT_CONFIG_COUNT" || name === "GIT_CONFIG_PARAMETERS") unresolved.push(name)
  }

  const count = env["GIT_CONFIG_COUNT"]
  if (count !== undefined && !unresolved.includes("GIT_CONFIG_COUNT")) {
    const n = Number.parseInt(count, 10)
    if (Number.isInteger(n) && n > 0) {
      for (let i = 0; i < n; i++) {
        const key = env[`GIT_CONFIG_KEY_${i}`]
        if (key === undefined) continue
        const value = env[`GIT_CONFIG_VALUE_${i}`]
        deltas.push({
          key: key.toLowerCase(),
          value: value === undefined ? true : value,
          channel: "envGitConfig",
        })
      }
    }
    // non-integer/negative/zero: git errors or no-op — not our finding
  }

  const params = env["GIT_CONFIG_PARAMETERS"]
  if (params !== undefined && !unresolved.includes("GIT_CONFIG_PARAMETERS")) {
    const parsed = parseConfigParameters(params)
    if (parsed.malformed) {
      malformedParameters = params
    } else {
      for (const item of parsed.items) {
        const eq = item.indexOf("=")
        deltas.push(
          eq === -1
            ? { key: item.toLowerCase(), value: true, channel: "configParameters" }
            : { key: item.slice(0, eq).toLowerCase(), value: item.slice(eq + 1), channel: "configParameters" },
)
      }
    }
  }

  if (env.GIT_CONFIG_GLOBAL !== undefined) hiding.push({ name: "GIT_CONFIG_GLOBAL", value: env.GIT_CONFIG_GLOBAL })
  if (env.GIT_CONFIG_SYSTEM !== undefined) hiding.push({ name: "GIT_CONFIG_SYSTEM", value: env.GIT_CONFIG_SYSTEM })
  if (env.GIT_CONFIG_NOSYSTEM !== undefined && /^(1|true|yes|on)$/i.test(env.GIT_CONFIG_NOSYSTEM)) {
    hiding.push({ name: "GIT_CONFIG_NOSYSTEM", value: env.GIT_CONFIG_NOSYSTEM })
  }

  for (const rule of MANAGER_ENV_RULES) {
    const value = env[rule.name]
    if (value !== undefined) manager.push({ rule, value })
  }
  const hkFile = env.HK_FILE

  const scopeNames: ScopeCandidate["name"][] = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_OBJECT_DIRECTORY", "GIT_INDEX_FILE"]
  for (const name of scopeNames) {
    const value = env[name]
    if (value !== undefined) scope.push({ name, value })
  }

  return { deltas, hiding, manager, scope, hkFile, unresolved, malformedParameters }
}

/**
 * Parses git's GIT_CONFIG_PARAMETERS grammar (verified empirically): a whitespace-separated
 * list of single-quoted `'key=value'` items (value optional → boolean true).
 * Any unquoted residue is malformed (git hard-errors "bogus format").
 */
export function parseConfigParameters(value: string): { items: string[]; malformed: boolean } {
  const items: string[] = []
  let i = 0
  const n = value.length
  while (i < n) {
    while (i < n && /\s/.test(value[i])) i++
    if (i >= n) break
    if (value[i] !== "'") return { items, malformed: true }
    const end = value.indexOf("'", i + 1)
    if (end === -1) return { items, malformed: true }
    items.push(value.slice(i + 1, end))
    i = end + 1
  }
  return { items, malformed: false }
}

/** PowerShell `$env:NAME = 'value'` / cmd `set NAME=value` are handled natively
 * by the dialect parsers (they emit `export` pseudo-commands). */
