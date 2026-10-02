// Core shared types for the classifier pipeline.

export type Level = "allow" | "ask" | "deny"

export type ShellKind = "bash" | "pwsh" | "powershell" | "cmd"

export type Finding = {
  invariantId: string
  level: Exclude<Level, "allow">
  evidence: string
  fixHint: string
}

export type Word = {
  kind: "word"
  /** Unquoted value (quotes/escapes resolved). Empty possible for quoted empty string. */
  value: string
  /** True when the entire word was a single quoted segment. */
  quoted: boolean
  /** True when the word contains any part we cannot statically resolve ($..., `...`). */
  dynamic: boolean
  /** Raw inner texts of $(...) `...` <(...) substitutions inside this word. */
  subs?: string[]
}

export type Operator = { kind: "op"; op: string }

export type Token = Word | Operator | { kind: "newline" }

export type Redirect = { op: string; target: Word }

export type Assignment = { name: string; value: string; dynamic: boolean }

export type SimpleCommand = {
  assignments: Assignment[]
  words: Word[]
  redirects: Redirect[]
  /** Raw inner texts of $(...) `...` <(...) substitutions found in any word of this command. */
  substitutions: string[]
  /** Source text of the command (best effort span). */
  raw: string
}

/** A leaf command after wrapper unwrapping, with all accumulated env. */
export type LeafCommand = {
  command: SimpleCommand
  /** Environment applying to this command: prefix assignments + env(1) + export + shims. */
  env: Record<string, string>
  /** Env entries whose value is statically unknown (dynamic). */
  envDynamic: string[]
}

export type ConfigDelta = {
  key: string
  /** String value, `true` for bare boolean keys, null for unresolved. */
  value: string | true | null
  channel: "dashC" | "configEnv" | "envGitConfig" | "configParameters" | "configSub"
  /** For configEnv: the env var name consulted. */
  envName?: string
  /** True for `git config --unset` style removals. */
  unset?: boolean
  /** Scope flag from the config subcommand (persistent channels). */
  scope?: "local" | "global" | "system" | "worktree" | "file"
}

export type GitInvocation = {
  exe: "git"
  globalOpts: {
    config: ConfigDelta[]
    configEnv: ConfigDelta[]
    gitDir?: string
    workTree?: string
  }
  subcommand: string
  /** Flag tokens recognized on the subcommand (bundled shorts expanded, values consumed). */
  flags: string[]
  /** Positional / unresolved tokens after the subcommand. */
  args: Word[]
  /** ALL tokens after the subcommand, in original order (for subcommand-specific grammars like `git config`). */
  rawArgs: Word[]
  /** True when any unconsumed argument token is dynamic. */
  hasDynamicArg: boolean
  raw: string
}

export class ParseError extends Error {
  reason: string
  constructor(reason: string, message?: string) {
    super(message ?? `unparseable shell construct: ${reason}`)
    this.reason = reason
  }
}
