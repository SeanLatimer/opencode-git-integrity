// Guard configuration: defaults → global file → project file (raise-only
// unless trustRepoConfig) → plugin options (user scope, full power).
// the design notes/§7. Validation is hand-rolled (no zod) to keep the plugin
// dependency-free — a deliberate choice (supply-chain auditability).

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Level } from "./types.js"

export type GuardConfig = {
  enabled: boolean
  failMode: "open" | "closed"
  policy: Record<string, Level>
  message: { header: string }
  trustRepoConfig: boolean
  /** Extra protected path globs (worktree-relative, `*` wildcard) for file tools & shell writes. */
  protectPaths: string[]
  /** Protect inert `.git/hooks/*.sample` files too (default false). */
  protectSampleHooks: boolean
  /** Ask on unknown `git <sub>` that may be a locally-defined alias (§5.2 #5). */
  strictAliases: boolean
}

export const DEFAULT_POLICY: Record<string, Exclude<Level, "allow">> = {
  "commit.hooks.must-run": "deny",
  "push.hooks.must-run": "deny",
  "commit.signing.must-stay-enabled": "deny",
  "tag.signing.must-stay-enabled": "ask",
  "push.signing.must-stay-enabled": "ask",
  "hooks.config.frozen": "deny",
  "signing.config.frozen": "deny",
  "hooks.files.protected": "deny",
  "git.metadata.protected": "deny",
  "hookmanagers.must-run": "deny",
  "guard.self-protected": "deny",
  "plumbing.suspicious": "ask",
  "alias.unresolved": "ask",
  "git.scope.shift": "ask",
  "x-dynamic-argument": "ask",
  "parse.failed": "deny",
}

const RANK: Record<Level, number> = { allow: 0, ask: 1, deny: 2 }
const KNOWN_KEYS = new Set(["enabled", "failMode", "policy", "message", "trustRepoConfig", "protectPaths", "protectSampleHooks", "strictAliases"])

export function defaultConfig(): GuardConfig {
  return {
    enabled: true,
    failMode: "closed",
    // deliberately empty: evaluator levels ARE the defaults (DEFAULT_POLICY
    // documents them); this map holds only explicitly configured overrides,
    // so deliberate ask-level downgrades survive unless the user overrides.
    policy: {},
    message: { header: "Blocked by git-guard." },
    trustRepoConfig: false,
    protectPaths: [".git/**"],
    protectSampleHooks: false,
    strictAliases: false,
  }
}

export function loadConfig(options: unknown, projectDir?: string): { config: GuardConfig; warnings: string[] } {
  const warnings: string[] = []
  const config = defaultConfig()

  const globalPath = join(homedir(), ".config", "opencode", "git-guard.json")
  applyFile(config, globalPath, "user", warnings)
  if (projectDir) {
    const projectPath = join(projectDir, ".opencode", "git-guard.json")
    applyFile(config, projectPath, config.trustRepoConfig ? "user" : "project", warnings)
  }
  applyLayer(config, options, "user", warnings, "plugin options")
  return { config, warnings }
}

function applyFile(config: GuardConfig, path: string, scope: "user" | "project", warnings: string[]) {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    warnings.push(`${path}: invalid JSON (${String(error)}) — ignored`)
    return
  }
  applyLayer(config, parsed, scope, warnings, path)
}

function applyLayer(config: GuardConfig, input: unknown, scope: "user" | "project", warnings: string[], label: string) {
  if (input == null) return
  if (typeof input !== "object" || Array.isArray(input)) {
    warnings.push(`${label}: expected an object — ignored`)
    return
  }
  const obj = input as Record<string, unknown>
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`${label}: unknown key \`${key}\` ignored`)
  }

  const userScope = scope === "user"

  if (typeof obj.enabled === "boolean") {
    if (userScope) config.enabled = obj.enabled
    else if (obj.enabled === false) warnings.push(`${label}: project cannot disable the guard — ignored`)
  }
  if (obj.failMode === "open" || obj.failMode === "closed") {
    if (userScope) config.failMode = obj.failMode
    else if (obj.failMode === "open" && config.failMode === "closed") {
      warnings.push(`${label}: project cannot weaken failMode closed→open — ignored`)
    } else config.failMode = obj.failMode
  }
  if (typeof obj.trustRepoConfig === "boolean") {
    if (userScope) config.trustRepoConfig = obj.trustRepoConfig
    else warnings.push(`${label}: trustRepoConfig only settable in user scope — ignored`)
  }
  if (typeof obj.message === "object" && obj.message !== null && !Array.isArray(obj.message)) {
    const header = (obj.message as Record<string, unknown>).header
    if (typeof header === "string" && header.length > 0) config.message.header = header
  }
  if (Array.isArray(obj.protectPaths)) {
    const paths = obj.protectPaths.filter((p): p is string => typeof p === "string" && p.length > 0)
    if (userScope) {
      config.protectPaths = paths
    } else {
      // project may only ADD protected paths, never remove defaults
      config.protectPaths = [...new Set([...config.protectPaths, ...paths])]
    }
  }
  if (typeof obj.protectSampleHooks === "boolean") {
    if (userScope) config.protectSampleHooks = obj.protectSampleHooks
    else if (obj.protectSampleHooks) config.protectSampleHooks = true
  }
  if (typeof obj.strictAliases === "boolean") {
    if (userScope) config.strictAliases = obj.strictAliases
    else if (obj.strictAliases) config.strictAliases = true // project may only raise
  }
  if (typeof obj.policy === "object" && obj.policy !== null && !Array.isArray(obj.policy)) {
    for (const [invariant, level] of Object.entries(obj.policy as Record<string, unknown>)) {
      if (level !== "allow" && level !== "ask" && level !== "deny") {
        warnings.push(`${label}: policy[${invariant}] must be allow|ask|deny — ignored`)
        continue
      }
      const baseline = config.policy[invariant] ?? DEFAULT_POLICY[invariant] ?? "ask"
      if (!userScope && RANK[level] < RANK[baseline]) {
        warnings.push(`${label}: project cannot lower policy[${invariant}] ${baseline}→${level} — ignored`)
        continue
      }
      config.policy[invariant] = level
    }
  }
}
