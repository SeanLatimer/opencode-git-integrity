// `git config` subcommand parsing — the persistent mutation
// channel. Read forms allow; set/unset forms produce ConfigDeltas (shared
// evaluator with -c/env channels); alias *creation* values are classified as
// git command text by the caller (alias-creation-with-violating-expansion).

import { ConfigDelta, GitInvocation } from "../types.js"

export type ConfigAction =
  | { kind: "read" }
  | { kind: "set"; key: string; value: string; valueDynamic?: boolean; scope: ConfigDelta["scope"] }
  | { kind: "unset"; key: string; scope: ConfigDelta["scope"] }
  | { kind: "remove-section"; section: string; scope: ConfigDelta["scope"] }

const SCOPES: Record<string, NonNullable<ConfigDelta["scope"]>> = {
  "--global": "global",
  "--system": "system",
  "--worktree": "worktree",
  "--local": "local",
}
const VALUE_FLAGS = new Set(["--file", "--blob", "--type", "--default"])

/** Parses the args of a `git config …` invocation into an action. */
export function parseConfigSubcommand(gi: GitInvocation): ConfigAction | null {
  const args = gi.rawArgs
  let scope: ConfigDelta["scope"] = "local"
  const positionals: Array<{ value: string; dynamic: boolean }> = []
  let sawVerbUnset = false
  let read = false

  let i = 0
  while (i < args.length) {
    const w = args[i]
    const v = w.value
    if (v === "--") { i++; continue }
    if (SCOPES[v]) { scope = SCOPES[v]; i++; continue }
    if (VALUE_FLAGS.has(v)) { i += 2; continue }
    if (v.startsWith("--file=") || v.startsWith("--blob=")) { i++; continue }
    if (v === "--get" || v === "--get-all" || v === "--get-regexp" || v === "--get-urlmatch" || v === "-l" || v === "--list" || v === "--edit" || v === "-e" || v === "--get-color" || v === "--get-colorbool" || v === "--get-regexp") { read = true; i++; continue }
    if (v === "--unset" || v === "--unset-all") {
      const key = args[i + 1]
      return key ? { kind: "unset", key: key.value.toLowerCase(), scope } : { kind: "read" }
    }
    if (v === "--remove-section") {
      const section = args[i + 1]
      return section ? { kind: "remove-section", section: section.value.toLowerCase(), scope } : { kind: "read" }
    }
    if (v === "--rename-section") return { kind: "read" } // alias-ish; not weakening
    if (v === "--add") { mode = "classic"; i++; continue } // --add name value follows
    // new-style verbs (git ≥2.46): git config set|get|unset|list|rename-section
    if (positionals.length === 0 && !w.dynamic) {
      const lv = v.toLowerCase()
      if (lv === "set") { i++; continue }
      if (lv === "get" || lv === "get-all" || lv === "get-regexp" || lv === "list") { read = true; i++; continue }
      if (lv === "unset") { sawVerbUnset = true; i++; continue }
      if (lv === "rename-section") return { kind: "read" }
    }
    positionals.push({ value: v, dynamic: w.dynamic })
    i++
  }

  if (read) return { kind: "read" }
  if (positionals.length === 0) return { kind: "read" }
  const key = positionals[0].value.toLowerCase()
  // new-style unset verb: `git config unset <key>`
  if (sawVerbUnset) return { kind: "unset", key, scope }
  if (positionals.length === 1) {
    // classic read form: `git config <key>`
    return { kind: "read" }
  }
  const value = positionals[1]
  return { kind: "set", key, value: value.value, valueDynamic: value.dynamic, scope }
}

export function configActionToDeltas(action: ConfigAction): ConfigDelta[] {
  if (action.kind === "set") {
    return [
      {
        key: action.key,
        value: action.valueDynamic ? null : action.value,
        channel: "configSub",
        scope: action.scope,
      },
    ]
  }
  if (action.kind === "unset") {
    return [{ key: action.key, value: null, channel: "configSub", unset: true, scope: action.scope }]
  }
  if (action.kind === "remove-section" && action.section === "core") {
    // removing [core] drops core.hooksPath with it
    return [{ key: "core.hookspath", value: null, channel: "configSub", unset: true, scope: action.scope }]
  }
  return []
}
