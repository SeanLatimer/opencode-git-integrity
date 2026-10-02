// Wrapper unwrapping: env(1), `bash -c`, `cmd /c`, `pwsh -Command`, nohup,
// watch, timeout, xargs, command/exec — down to leaf commands carrying the
// accumulated environment. Recursion depth capped at 5.

import { ParseError, SimpleCommand, Word } from "../types.js"
import { lex } from "./lexer.js"
import { buildCommands } from "./commands.js"
import { parsePowerShell } from "./powershell.js"
import { parseCmd } from "./cmd.js"
import type { Dialect } from "../classify/shell.js"

export type Leaf = { cmd: SimpleCommand; env: Record<string, string>; envDynamic: string[] }

const MAX_DEPTH = 5

const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "dash", "ash", "ksh"])
const DROP_PROGRAM = new Set(["nohup", "watch", "command", "exec", "builtin", "call"])
// Command routers: execute the wrapped command (argv[1..]) as-is. Discovered in live testing — the user's global `rtk` plugin rewrites shell
// commands to `rtk <cmd>` in tool.execute.before before our evaluate hook runs.
const COMMAND_ROUTERS = new Set(["rtk", "mise", "asdf", "volta", "fvm"])
const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

export function normalizeProgram(v: string): string {
  let s = v.replace(/\\/g, "/")
  const slash = s.lastIndexOf("/")
  if (slash >= 0) s = s.slice(slash + 1)
  if (s.toLowerCase().endsWith(".exe")) s = s.slice(0, -4)
  return s.toLowerCase()
}

export function unwrapAll(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth = 0): Leaf[] {
  if (depth > MAX_DEPTH) throw new ParseError("depth", "wrapper nesting exceeds depth cap")
  const program = cmd.words[0]
  if (!program) return []
  const name = normalizeProgram(program.value)

  if (name === "env") return unwrapEnv(cmd, env, envDynamic, depth)
  if (SHELL_WRAPPERS.has(name)) return unwrapShellScript(cmd, env, envDynamic, depth)
  if (name === "cmd") return unwrapCmd(cmd, env, envDynamic, depth)
  if (name === "pwsh" || name === "powershell") return unwrapPwsh(cmd, env, envDynamic, depth)
  if (name === "timeout") return unwrapTimeout(cmd, env, envDynamic, depth)
  if (name === "xargs") return unwrapXargs(cmd, env, envDynamic, depth)
  if (COMMAND_ROUTERS.has(name)) return unwrapRouter(cmd, env, envDynamic, depth)
  if (name === "start-process") return unwrapStartProcess(cmd, env, envDynamic, depth)
  if (name === "start") {
    // cmd `start` — an optional first quoted arg is the window title, then the command
    let rest = cmd.words.slice(1)
    if (rest.length > 1 && rest[0].quoted && rest[0].value === "") rest = rest.slice(1)
    if (rest.length === 0) return []
    return unwrapAll(makeCmd(rest), env, envDynamic, depth + 1)
  }
  if (DROP_PROGRAM.has(name)) {
    const rest = cmd.words.slice(1)
    if (rest.length === 0) return []
    return unwrapAll(makeCmd(rest), env, envDynamic, depth + 1)
  }
  return [{ cmd, env, envDynamic }]
}

function makeCmd(words: Word[]): SimpleCommand {
  return {
    assignments: [],
    words,
    redirects: [],
    substitutions: words.flatMap((w) => w.subs ?? []),
    raw: words.map((w) => (w.quoted ? `"${w.value}"` : w.value)).join(" "),
  }
}

function nested(text: string, dialect: Dialect): SimpleCommand[] {
  if (dialect === "pwsh") return parsePowerShell(text)
  if (dialect === "cmd") return parseCmd(text)
  return buildCommands(lex(text))
}

/** env [-i] [-u NAME]… [NAME=VALUE]… [COMMAND [ARG]…] */
function unwrapEnv(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  const nextEnv = { ...env }
  const nextDynamic = [...envDynamic]
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (w.dynamic) break
    const v = w.value
    if (v === "-u" || v === "--unset") {
      i += 2
      continue
    }
    if (v.startsWith("-")) {
      i++
      continue
    }
    if (ASSIGN_RE.test(v)) {
      const eq = v.indexOf("=")
      if (w.dynamic) {
        nextDynamic.push(v.slice(0, eq))
      } else {
        nextEnv[v.slice(0, eq)] = v.slice(eq + 1)
      }
      i++
      continue
    }
    return unwrapAll(makeCmd(words.slice(i)), nextEnv, nextDynamic, depth + 1)
  }
  return []
}

/** bash/sh/… [-l] -c 'script' — the payload is POSIX shell by construction. */
function unwrapShellScript(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.dynamic) continue
    if (/^-[a-z]*c$/i.test(w.value)) {
      const script = words[i + 1]
      if (!script || script.dynamic) throw new ParseError("dynamic-script")
      return nested(script.value, "posix").flatMap((c) => unwrapAll(c, env, envDynamic, depth + 1))
    }
  }
  // No -c: runs a script file — opaque, stays a non-git leaf (documented gap).
  return [{ cmd, env, envDynamic }]
}

/** cmd /c "script" (also /k) — the payload is cmd.exe syntax. */
function unwrapCmd(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.dynamic) continue
    const v = w.value.toLowerCase()
    if (v === "/c" || v === "/k") {
      const script = words[i + 1]
      if (!script || script.dynamic) throw new ParseError("dynamic-script")
      return nested(script.value, "cmd").flatMap((c) => unwrapAll(c, env, envDynamic, depth + 1))
    }
  }
  return [{ cmd, env, envDynamic }]
}

/** pwsh/powershell -Command 'script' — the payload is PowerShell. -File/-EncodedCommand stay opaque (documented). */
function unwrapPwsh(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w.dynamic) continue
    const v = w.value.toLowerCase()
    if (v === "-command" || v === "-c" || v === "--command") {
      const script = words[i + 1]
      if (!script || script.dynamic) throw new ParseError("dynamic-script")
      return nested(script.value, "pwsh").flatMap((c) => unwrapAll(c, env, envDynamic, depth + 1))
    }
  }
  return [{ cmd, env, envDynamic }]
}

/** Start-Process [-FilePath] <prog> [-ArgumentList <args…>] — literal forms only. */
const START_PROCESS_SWITCHES = new Set([
  "-verb", "-windowstyle", "-workingdirectory", "-nonewwindow", "-wait", "-passthru", "-credential",
  "-loaduserprofile", "-redirectstandardoutput", "-redirectstandarderror", "-redirectstandardinput",
  "-usenewenvironment", "-runas", "-nostartupfiles",
])
function unwrapStartProcess(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  let filePath: Word | undefined
  const args: Word[] = []
  let mode: "none" | "file" | "args" = "none"
  for (const w of words) {
    if (w.dynamic) return [{ cmd, env, envDynamic }] // dynamic — documented miss
    const v = w.value.toLowerCase()
    if (v === "-filepath" || v === "-file") {
      mode = "file"
      continue
    }
    if (v === "-argumentlist" || v === "-args") {
      mode = "args"
      continue
    }
    if (v.startsWith("-") && !(mode === "args" && !START_PROCESS_SWITCHES.has(v))) continue // other switches
    if (mode === "file" || (mode === "none" && !filePath)) filePath = w
    else if (mode !== "none") args.push(w)
  }
  if (!filePath || !filePath.value) return [{ cmd, env, envDynamic }]
  return unwrapAll(makeCmd([filePath, ...args]), env, envDynamic, depth + 1)
}

/** timeout [--flags] <duration> command … */
function unwrapTimeout(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (w.dynamic) return [{ cmd, env, envDynamic }]
    if (w.value.startsWith("-")) {
      // --signal=KILL etc are self-contained; bare long flags assumed boolean
      i++
      continue
    }
    if (/^\d+(\.\d+)?(s|m|h|d)?$/i.test(w.value) || w.value === "forever") {
      i++
      break
    }
    break
  }
  const rest = words.slice(i)
  if (rest.length === 0) return []
  return unwrapAll(makeCmd(rest), env, envDynamic, depth + 1)
}

/** xargs [flags] [command [initial-args…]] */
function unwrapXargs(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  let i = 0
  while (i < words.length && !words[i].dynamic && words[i].value.startsWith("-")) i++
  const rest = words.slice(i)
  if (rest.length === 0) return []
  return unwrapAll(makeCmd(rest), env, envDynamic, depth + 1)
}

/**
 * Command routers (`rtk`, `mise`, `asdf`, …): `[flags] [verb] [flags] [--] wrapped-command`.
 * Verbs {exec, x, run} are skipped when present positionally. Unknown routers
 * not in COMMAND_ROUTERS remain a documented limitation.
 */
function unwrapRouter(cmd: SimpleCommand, env: Record<string, string>, envDynamic: string[], depth: number): Leaf[] {
  const words = cmd.words.slice(1)
  const VERBS = new Set(["exec", "x", "run"])
  let i = 0
  const skipFlags = () => {
    while (i < words.length && !words[i].dynamic && words[i].value.startsWith("-") && words[i].value !== "--") i++
  }
  skipFlags()
  if (words[i] && !words[i].dynamic && VERBS.has(words[i].value)) {
    i++
    skipFlags()
  }
  if (words[i] && !words[i].dynamic && words[i].value === "--") i++
  const rest = words.slice(i)
  if (rest.length === 0) return [{ cmd, env, envDynamic }]
  return unwrapAll(makeCmd(rest), env, envDynamic, depth + 1)
}
