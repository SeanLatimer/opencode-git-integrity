// Code Mode (`execute` tool) protection — required by the finding that the
// execute tool bypasses the permission pipeline entirely (verified live).
//
// Scans JS source for process-spawn call sites and extracts *literal* commands:
//   Bun.spawnSync("git commit --no-verify")          (string form → shell text)
//   Bun.spawnSync(["git","commit","--no-verify"])    (array form → argv)
//   Bun.spawnSync({ cmd: ["git", …] })               (object form)
//   await Bun.$`git commit --no-verify`              (shell template)
//   spawnSync(…)/exec(…)/execSync(…) bare forms      (destructured aliases)
// Wrapper programs inside the literal (cmd.exe /c, sh -c, bash -c) are unwrapped
// before classification. Dynamically computed commands are a documented
// limitation and are not flagged.

import { Finding } from "../types.js"
import { ClassifierDeps, Decision, classifyResource, pick } from "./shell.js"

const CALL_RE = /([A-Za-z_$][\w$]*)\s*(?:\.\s*([A-Za-z_$][\w$]*))?\s*\(/g
const SPAWN_CALLEES = new Set(["spawn", "spawnSync", "exec", "execSync", "$"])
const BUN_SHELL_RE = /Bun\s*\.\s*\$\s*`([^`]*)`/g

export function classifyCodeMode(code: string, deps: ClassifierDeps): Decision {
  const findings: Finding[] = []
  const env: Record<string, string> = {}

  BUN_SHELL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = BUN_SHELL_RE.exec(code)) !== null) {
    if (m[1].includes("${")) continue // dynamic template — documented miss
    pushCodeFinding(classifyResource(m[1], deps, env, 0), `Bun.$ template`, findings)
  }

  CALL_RE.lastIndex = 0
  while ((m = CALL_RE.exec(code)) !== null) {
    const [, object, method] = m
    const callee = method ?? object
    if (!callee || !SPAWN_CALLEES.has(callee)) continue
    if (callee === "$" && object !== "Bun") continue // only Bun.$ is a shell
    const argsText = balancedArgs(code, m.index + m[0].length - 1)
    if (argsText === undefined) continue
    const literal = firstArgLiteral(argsText)
    if (literal === undefined) continue // dynamic first argument — documented miss
    const where = object ? `${object}.${callee}` : callee
    if (literal.kind === "argv") {
      const unwrapped = unwrapArgv(literal.value)
      if (unwrapped === undefined) continue
      pushCodeFinding(classifyResource(unwrapped, deps, env, 0), `${where}(…)`, findings)
    } else {
      pushCodeFinding(classifyResource(literal.value, deps, env, 0), `${where}(…)`, findings)
    }
  }

  return pick(findings)
}

function pushCodeFinding(result: Decision, where: string, findings: Finding[]) {
  if (!result.finding) return
  findings.push({
    ...result.finding,
    evidence: `Code Mode (execute tool) ${where}: ${result.finding.evidence}`,
  })
}

/** Extracts the balanced argument text after the '(' at openIdx. */
function balancedArgs(code: string, openIdx: number): string | undefined {
  let depth = 1
  let i = openIdx + 1
  let inStr: string | null = null
  while (i < code.length) {
    const c = code[i]
    if (inStr) {
      if (c === "\\") {
        i += 2
        continue
      }
      if (c === inStr) inStr = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === "`") {
      inStr = c
      i++
      continue
    }
    if (c === "(" || c === "[" || c === "{") depth++
    if (c === ")" || c === "]" || c === "}") {
      depth--
      if (depth === 0) return code.slice(openIdx + 1, i)
    }
    i++
  }
  return undefined
}

type Literal = { kind: "string"; value: string } | { kind: "argv"; value: string[] }

/**
 * Extracts the first argument if it is a literal: a string, an array of
 * strings, or an object literal with a literal `cmd` property.
 */
function firstArgLiteral(argsText: string): Literal | undefined {
  const t = argsText.trim()
  if (t.startsWith("[")) {
    const elements = parseArrayLiteral(t)
    if (elements === undefined) return undefined
    return { kind: "argv", value: elements }
  }
  if (t.startsWith("{")) {
    const m = /\bcmd\s*:\s*(\[[\s\S]*?\]|"[^"]*"|'[^']*'|`[^`]*`)/.exec(t)
    if (!m) return undefined
    if (m[1].startsWith("[")) {
      const elements = parseArrayLiteral(m[1])
      return elements === undefined ? undefined : { kind: "argv", value: elements }
    }
    return { kind: "string", value: unquote(m[1]) }
  }
  if (t.startsWith('"') || t.startsWith("'") || t.startsWith("`")) {
    const quote = t[0]
    const end = t.indexOf(quote, 1)
    if (end === -1) return undefined
    const value = t.slice(1, end)
    if (quote === "`" && value.includes("${")) return undefined
    return { kind: "string", value: value.replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1") }
  }
  return undefined
}

function parseArrayLiteral(text: string): string[] | undefined {
  const inner = text.slice(1, text.lastIndexOf("]"))
  if (!inner.trim()) return []
  const out: string[] = []
  let i = 0
  while (i < inner.length) {
    while (i < inner.length && /[\s,]/.test(inner[i])) i++
    if (i >= inner.length) break
    const quote = inner[i]
    if (quote !== '"' && quote !== "'" && quote !== "`") return undefined // non-literal element
    const end = inner.indexOf(quote, i + 1)
    if (end === -1) return undefined
    out.push(inner.slice(i + 1, end).replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1"))
    i = end + 1
  }
  return out
}

function unquote(text: string): string {
  return text.slice(1, -1).replace(/\\n/g, " ").replace(/\\(["'`\\])/g, "$1")
}

/** Turns an argv literal into classifiable command text, unwrapping shells and
 * quoting elements that would otherwise change meaning when re-lexed (the
 * `["git","commit","-m","use --no-verify next time"]` FP class). */
function unwrapArgv(argv: string[]): string | undefined {
  if (argv.length === 0) return undefined
  const program = argv[0].replace(/\.exe$/i, "").replace(/\\/g, "/").split("/").pop()!.toLowerCase()
  if (program === "cmd" && argv[1] !== undefined && argv[1].toLowerCase() === "/c") return argv.slice(2).join(" ")
  if ((program === "sh" || program === "bash" || program === "pwsh" || program === "powershell") && argv.includes("-c")) {
    const idx = argv.findIndex((a) => a === "-c" || a === "-Command" || a === "-command")
    return argv.slice(idx + 1).join(" ")
  }
  return argv.map(quoteArgv).join(" ")
}

function quoteArgv(el: string): string {
  if (el === "" || /\s/.test(el) || /[;&|<>"'`$\\#*?~]/.test(el)) {
    return '"' + el.replace(/(["\\])/g, "\\$1") + '"'
  }
  return el
}
