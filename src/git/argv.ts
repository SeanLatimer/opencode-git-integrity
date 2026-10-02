// GitInvocation IR: splits global options (-c, --config-env, -C, --git-dir, …)
// from the subcommand and its arguments, with position-sensitive flag parsing
// per subcommand (`git -c k=v commit` ≠ `git commit -c <sha>`), bundled short
// expansion, `--opt=value`/`--opt value` handling, and the `--` separator.
// Never re-splits raw text — only lexer-produced word tokens are used.

import { ConfigDelta, GitInvocation, SimpleCommand, Word } from "../types.js"
import { normalizeProgram } from "../parse/unwrap.js"

type ShortSpec = "bool" | "value" | "valueOpt"
type Schema = { shorts: Record<string, ShortSpec>; longs: Record<string, "bool" | "value" | "valueOpt"> }

// Value-taking flags enumerated so their arguments are consumed as DATA and can
// never be mistaken for flags (the `git commit -m "--no-verify"` FP class).
const SCHEMAS: Record<string, Schema> = {
  commit: {
    shorts: { m: "value", F: "value", c: "value", C: "value", t: "value", v: "bool", q: "bool", n: "bool", e: "bool", a: "bool", s: "bool", i: "bool", o: "bool", p: "bool" },
    longs: {
      message: "value", file: "value", author: "value", date: "value", "reuse-message": "value", "reedit-message": "value",
      fixup: "value", squash: "value", template: "value", cleanup: "value", trailer: "value", branch: "value", "pathspec-from-file": "value",
      "untracked-files": "valueOpt", "gpg-sign": "valueOpt", verbosity: "valueOpt",
      "no-verify": "bool", "no-gpg-sign": "bool", amend: "bool", "allow-empty": "bool", "allow-empty-message": "bool", edit: "bool",
      "no-edit": "bool", quiet: "bool", verbose: "bool", all: "bool", signoff: "bool", "no-signoff": "bool", include: "bool", only: "bool",
      "dry-run": "bool", short: "bool", porcelain: "bool", long: "bool", null: "bool", patch: "bool", "no-post-rewrite": "bool",
    },
  },
  am: {
    shorts: { k: "bool", s: "bool", q: "bool", v: "bool", i: "bool", c: "value", u: "valueOpt", p: "valueOpt", "3": "bool" } as Record<string, ShortSpec>,
    longs: {
      "no-verify": "bool", "no-gpg-sign": "bool", "gpg-sign": "valueOpt", sign: "bool", "no-sign": "bool", keep: "bool", "no-keep": "bool",
      quiet: "bool", "message-id": "bool", "no-message-id": "bool", scissors: "bool", "no-scissors": "bool",
      "committer-date-is-author-date": "bool", "ignore-date": "bool", "ignore-whitespace": "bool", "ignore-space-change": "bool",
      directory: "value", exclude: "value", "patch-format": "value", empty: "valueOpt", "show-current-patch": "valueOpt",
      interactive: "bool", "no-interactive": "bool", message: "value", abort: "bool", "skip": "bool",
      "continue": "bool", "resolvemsg": "value", whitespace: "value", "no-utf8": "bool",
    },
  },
  merge: {
    shorts: { m: "value", s: "value", X: "value", n: "bool", q: "bool", v: "bool", e: "bool", squash: "bool" },
    longs: {
      message: "value", file: "value", log: "valueOpt", strategy: "value", "strategy-option": "value", "into-name": "value", cleanup: "value",
      "gpg-sign": "valueOpt", "no-gpg-sign": "bool", "no-verify": "bool", "no-verify-signatures": "bool", verify: "bool",
      "verify-signatures": "bool", "continue": "bool", abort: "bool", quit: "bool", autostash: "bool", "no-autostash": "bool",
      commit: "bool", "no-commit": "bool", edit: "bool", "no-edit": "bool", ff: "valueOpt", "no-ff": "bool", "ff-only": "bool",
      quiet: "bool", verbose: "bool", progress: "bool", "no-progress": "bool", stat: "bool", "no-stat": "bool",
      "allow-unrelated-histories": "bool", "rerere-autoupdate": "bool", "overwrite-ignore": "bool", signoff: "bool",
    },
  },
  pull: {
    shorts: { m: "value", s: "value", X: "value", r: "valueOpt", q: "bool", v: "bool", n: "bool", k: "bool" },
    longs: {
      "no-verify": "bool", "gpg-sign": "valueOpt", "no-gpg-sign": "bool", "no-rebase": "bool", rebase: "valueOpt", ff: "valueOpt",
      "no-ff": "bool", "ff-only": "bool", "verify-signatures": "bool", squash: "bool", commit: "bool",
      "no-commit": "bool", edit: "bool", "no-edit": "bool", stat: "bool", "no-stat": "bool", strategy: "value", "strategy-option": "value",
      "autostash": "bool", "no-autostash": "bool", "allow-unrelated-histories": "bool", quiet: "bool", verbose: "bool",
      "recurse-submodules": "valueOpt", "no-recurse-submodules": "bool", "untracked-files": "valueOpt", depth: "valueOpt",
      verify: "bool", "no-verify-signatures": "bool", all: "bool", append: "bool",
    },
  },
  push: {
    shorts: { n: "bool", f: "bool", u: "valueOpt", d: "bool", D: "bool", q: "bool", v: "bool", t: "bool", o: "valueOpt" },
    longs: {
      "no-verify": "bool", signed: "valueOpt", "no-signed": "bool", "dry-run": "bool", "receive-pack": "value", exec: "value",
      repo: "value", "push-option": "valueOpt", force: "valueOpt", "no-force": "bool", "force-with-lease": "valueOpt",
      "no-force-with-lease": "bool", "set-upstream": "bool", "delete": "bool", "all": "bool", "mirror": "bool", "tags": "bool",
      "follow-tags": "bool", "atomic": "bool", "no-atomic": "bool", "porcelain": "bool", "thin": "bool", "no-thin": "bool",
      quiet: "bool", verbose: "bool", progress: "bool", "no-progress": "bool", "recurse-submodules": "valueOpt", prune: "bool",
      "no-prune": "bool", "verify": "bool", "signed-if-asked": "bool",
    },
  },
  tag: {
    shorts: { m: "value", F: "value", a: "bool", s: "bool", u: "valueOpt", f: "bool", d: "bool", v: "bool", l: "bool", n: "valueOpt" },
    longs: {
      "no-sign": "bool", sign: "bool", annotate: "bool", message: "value", file: "value", "local-user": "valueOpt",
      force: "bool", delete: "bool", verify: "bool", list: "bool", "column": "valueOpt", "sort": "value", "format": "value",
      "contains": "value", "points-at": "value", "merged": "value", "no-merged": "value", "ignore-case": "bool", "create-reflog": "bool",
    },
  },
  config: {
    shorts: { t: "value", f: "bool", e: "bool", z: "bool", l: "bool" },
    longs: {} as Record<string, "bool" | "value" | "valueOpt">,
  },
}

const GLOBAL_VALUE_OPTS = new Set(["--git-dir", "--work-tree", "--namespace", "--git-common-dir", "--super-prefix"])
const GLOBAL_BOOL_OPTS = new Set([
  "--no-pager", "--paginate", "--bare", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs",
  "--icase-pathspecs", "--no-optional-locks", "--no-replace-objects", "--no-lazy-fetch", "--no-advice",
  "--exec-path", "--html-path", "--man-path", "--info-path", "--version", "--help", "--no-minimal-search",
])

export function isGitProgram(program: Word): boolean {
  if (program.dynamic) return false
  return normalizeProgram(program.value) === "git"
}

export function parseGitInvocation(cmd: SimpleCommand, raw: string): GitInvocation | null {
  const program = cmd.words[0]
  if (!program || !isGitProgram(program)) return null

  const config: ConfigDelta[] = []
  const configEnv: ConfigDelta[] = []
  let gitDir: string | undefined
  let workTree: string | undefined

  let i = 1
  let subcommand = ""
  while (i < cmd.words.length) {
    const w = cmd.words[i]
    if (w.dynamic) {
      subcommand = ""
      break
    }
    const v = w.value
    if (!v.startsWith("-") || v === "-" || v === "--") {
      subcommand = v
      i++
      break
    }
    // git global options
    if (v === "-c" || v.startsWith("-c")) {
      const attached = v.length > 2 ? v.slice(2) : undefined
      if (attached !== undefined) {
        config.push(deltaFromDashC(attached))
        i++
      } else {
        const val = cmd.words[i + 1]
        if (!val) break
        config.push(deltaFromDashC(val.dynamic ? null : val.value, val.dynamic))
        i += 2
      }
      continue
    }
    if (v.startsWith("--config-env=") || v === "--config-env") {
      const attached = v.startsWith("--config-env=") ? v.slice("--config-env=".length) : undefined
      if (attached !== undefined && attached.includes("=")) {
        const eq = attached.indexOf("=")
        configEnv.push({ key: attached.slice(0, eq).toLowerCase(), value: null, channel: "configEnv", envName: attached.slice(eq + 1) })
        i++
      } else if (v === "--config-env") {
        const val = cmd.words[i + 1]
        if (!val || val.dynamic) break
        const eq = val.value.indexOf("=")
        if (eq > 0) {
          configEnv.push({ key: val.value.slice(0, eq).toLowerCase(), value: null, channel: "configEnv", envName: val.value.slice(eq + 1) })
          i += 2
          continue
        }
        break
      } else {
        i++
      }
      continue
    }
    if (v.startsWith("--config-env")) {
      i++
      continue
    }
    if (v === "-C" || v.startsWith("-C")) {
      const attached = v.length > 2 ? v.slice(2) : undefined
      if (attached !== undefined) i++
      else if (cmd.words[i + 1]) i += 2
      else break
      continue
    }
    if (v.startsWith("--git-dir=")) {
      gitDir = v.slice("--git-dir=".length)
      i++
      continue
    }
    if (v.startsWith("--work-tree=")) {
      workTree = v.slice("--work-tree=".length)
      i++
      continue
    }
    if (GLOBAL_VALUE_OPTS.has(v)) {
      i += 2
      continue
    }
    if (GLOBAL_BOOL_OPTS.has(v) || v.includes("=") || v.startsWith("-")) {
      // unknown '-'-token: assume boolean (value forms carry '=')
      i++
      continue
    }
    subcommand = v
    i++
    break
  }

  const subWords = cmd.words.slice(i)
  const parsed = parseSubArgs(subcommand, subWords)

  return {
    exe: "git",
    globalOpts: { config, configEnv, gitDir, workTree },
    subcommand,
    flags: parsed.flags,
    args: parsed.args,
    rawArgs: subWords,
    hasDynamicArg: parsed.hasDynamicArg,
    raw,
  }
}

function deltaFromDashC(text: string | null, dynamic = false): ConfigDelta {
  if (text === null || dynamic) return { key: "", value: null, channel: "dashC" }
  const eq = text.indexOf("=")
  if (eq === -1) return { key: text.toLowerCase(), value: true, channel: "dashC" }
  return { key: text.slice(0, eq).toLowerCase(), value: text.slice(eq + 1), channel: "dashC" }
}

function parseSubArgs(subcommand: string, words: Word[]): { flags: string[]; args: Word[]; hasDynamicArg: boolean } {
  const schema = SCHEMAS[subcommand]
  const flags: string[] = []
  const args: Word[] = []
  let hasDynamicArg = false
  let onlyPositional = false

  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (onlyPositional) {
      if (w.dynamic) hasDynamicArg = true
      args.push(w)
      i++
      continue
    }
    if (w.dynamic) {
      hasDynamicArg = true
      args.push(w)
      i++
      continue
    }
    const v = w.value
    if (v === "--") {
      onlyPositional = true
      i++
      continue
    }
    if (!v.startsWith("-") || v === "-") {
      args.push(w)
      i++
      continue
    }
    if (v.startsWith("--")) {
      const eq = v.indexOf("=")
      const name = eq === -1 ? v.slice(2) : v.slice(2, eq)
      const spec = schema?.longs[name]
      if (spec === "value" && eq === -1) {
        flags.push(v)
        i += 2 // consume the value token as data
        continue
      }
      flags.push(v)
      i++
      continue
    }
    // short cluster
    const chars = v.slice(1)
    let consumedNext = false
    for (let j = 0; j < chars.length; j++) {
      const spec = schema?.shorts[chars[j]]
      if (spec === "bool") {
        flags.push("-" + chars[j])
        continue
      }
      if (spec === "value" || spec === "valueOpt") {
        flags.push("-" + chars[j])
        if (j === chars.length - 1 && spec === "value") consumedNext = true
        break
      }
      // unknown short: keep the cluster as-is; git would reject it anyway
      flags.push(v)
      break
    }
    i += consumedNext ? 2 : 1
  }
  return { flags, args, hasDynamicArg }
}
