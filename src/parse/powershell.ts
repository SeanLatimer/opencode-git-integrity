// PowerShell statement parser . Produces the shared
// SimpleCommand[] IR so the downstream unwrap → git-argv → invariants chain is
// dialect-independent.
//
// Handles: `;`/newline/`&&`/`||`/`|` statement splitting, `$env:NAME = value`
// (emitted as `export` pseudo-commands so env coupling is order-correct),
// quoting ('…', "…" with $var/`$(…)`/backtick escapes), the `&` call operator,
// `-Param value` / `-Param:value`, comma-separated argument arrays (PS passes
// them as separate argv entries — mirrored here), redirects (>, >>, 2>, 2>&1,
// *>), `#` and `<# #>` comments, and backtick line continuation.
//
// Rejected (ParseError → fail-mode gate): compound statements (if/foreach/try/
// switch/…), scriptblocks, here-strings, Invoke-Expression/iex (dynamic
// execution), parenthesized groups.

import { ParseError, SimpleCommand, Word } from "../types.js"

const COMPOUND = new Set([
  "if", "elseif", "foreach", "while", "until", "for", "switch", "do", "try", "catch", "finally",
  "function", "filter", "workflow", "class", "enum", "param", "begin", "process", "end",
])
const DYNAMIC_EXEC = new Set(["iex", "invoke-expression"])

export function parsePowerShell(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  let i = 0
  const n = text.length

  const skipSeparators = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === ";" || text[i] === "\n")) i++
  }

  while (true) {
    skipSeparators()
    if (i >= n) break
    const c = text[i]

    if (c === "#") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "<" && text.slice(i, i + 2) === "<#") {
      const end = text.indexOf("#>", i + 2)
      if (end === -1) throw new ParseError("ps-block-comment")
      i = end + 2
      continue
    }
    if (c === "|" || c === "&") {
      // stray pipeline/separator after another statement
      i++
      continue
    }

    // statement dispatch
    if (text.startsWith("$env:", i)) {
      const m = /^\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=?/.exec(text.slice(i))
      if (!m) throw new ParseError("ps-expression")
      i += m[0].length
      if (!m[0].includes("=")) continue // bare $env: reference inside a larger token
      const value = readValueToken()
      if (value.dynamic) {
        commands.push(exportCommand(word(`${m[1]}=`, true, true)))
      } else {
        commands.push(exportCommand(word(`${m[1]}=${value.value}`, false, false)))
      }
      continue
    }
    if (c === "$") {
      // non-env assignment or expression: read+skip the statement (not exported)
      skipStatement()
      continue
    }
    if (c === "(") throw new ParseError("ps-group")
    if (c === "{") throw new ParseError("ps-scriptblock")
    if (c === "." && /\s/.test(text[i + 1] ?? " ")) throw new ParseError("ps-dot-source")
    if (c === "@" && (text.slice(i, i + 2) === '@"' || text.slice(i, i + 2) === "@'")) {
      throw new ParseError("ps-here-string")
    }

    // command statement (optionally via call operator `&`)
    if (c === "&" && /\s/.test(text[i + 1] ?? " ")) i++
    const cmd = readCommand()
    if (cmd) commands.push(cmd)
  }
  return commands

  function word(value: string, dynamic: boolean, bare: boolean): Word {
    return { kind: "word", value, quoted: !bare, dynamic }
  }

  function exportCommand(w: Word): SimpleCommand {
    return { assignments: [], words: [word("export", false, true), w], redirects: [], substitutions: [], raw: `export ${w.value}` }
  }

  /** Reads the right-hand side of an assignment: quoted string or bare token. */
  function readValueToken(): { value: string; dynamic: boolean } {
    skipSpaces()
    if (text[i] === "'") return readSingleQuoted()
    if (text[i] === '"') return readDoubleQuoted()
    let value = ""
    let dynamic = false
    while (i < n && !/[\s;|&<>#]/.test(text[i])) {
      if (text[i] === "`") {
        value += backtickChar(text[i + 1])
        i += 2
        continue
      }
      if (text[i] === "$") dynamic = true
      if (text[i] === "%" && text[i + 1] !== undefined) dynamic = true
      value += text[i]
      i++
    }
    return { value, dynamic }
  }

  function readSingleQuoted(): { value: string; dynamic: boolean } {
    i++ // '
    let value = ""
    while (i < n) {
      if (text[i] === "'" && text[i + 1] === "'") {
        value += "'"
        i += 2
        continue
      }
      if (text[i] === "'") {
        i++
        return { value, dynamic: false }
      }
      value += text[i]
      i++
    }
    throw new ParseError("unterminated-quote")
  }

  function readDoubleQuoted(): { value: string; dynamic: boolean; subs: string[] } {
    i++ // "
    let value = ""
    let dynamic = false
    const subs: string[] = []
    while (i < n) {
      const c = text[i]
      if (c === "`") {
        const e = text[i + 1]
        if (e === "\n") {
          i += 2
          continue
        }
        if (e === "$" || e === '"' || e === "`") {
          value += e
          i += 2
          continue
        }
        value += backtickChar(e)
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return { value, dynamic, subs }
      }
      if (c === "$" && text[i + 1] === "(") {
        const inner = captureSubexpression()
        subs.push(inner)
        dynamic = true
        continue
      }
      if (c === "$" || c === "`") {
        dynamic = true
        i++
        continue
      }
      value += c
      i++
    }
    throw new ParseError("unterminated-quote")
  }

  function captureSubexpression(): string {
    // at '$('
    let depth = 1
    let j = i + 2
    while (j < n && depth > 0) {
      if (text[j] === "(") depth++
      if (text[j] === ")") depth--
      j++
    }
    if (depth > 0) throw new ParseError("unterminated-substitution")
    const inner = text.slice(i + 2, j - 1)
    i = j
    return inner
  }

  function skipSpaces() {
    while (i < n && (text[i] === " " || text[i] === "\t")) i++
  }

  /** Skips an expression statement (non-exported assignments etc.). */
  function skipStatement() {
    while (i < n && text[i] !== "\n" && text[i] !== ";") i++
  }

  function readCommand(): SimpleCommand | null {
    const words: Word[] = []
    const redirects: SimpleCommand["redirects"] = []
    const subs: string[] = []
    let raw = ""

    const finish = () => {
      if (words.length === 0) return null
      const suspense = psProgramSuspense(words[0].value)
      if (suspense) throw suspense
      raw = words.map((w) => (w.quoted ? `"${w.value}"` : w.value)).join(" ")
      return { assignments: [], words, redirects, substitutions: subs, raw }
    }

    while (i < n) {
      const c = text[i]
      if (c === " " || c === "\t" || c === "\r" || c === "," || c === "\n" || c === ";") {
        i++
        if (c === "\n" || c === ";") return finish()
        continue
      }
      if (c === "#" && words.length > 0) {
        while (i < n && text[i] !== "\n") i++
        return finish()
      }
      if (c === "#" && text[i + 1] !== undefined && /[!#]/.test(text[i + 1]) === false) {
        // comment at command position — skip line, continue statement loop
        while (i < n && text[i] !== "\n") i++
        continue
      }
      if (c === "|" || c === "&") {
        // pipeline / && / || / background — end this command, continue parsing
        if (text.slice(i, i + 2) === "&&" || text.slice(i, i + 2) === "||") i += 2
        else i++
        const done = finish()
        return done
      }
      if (c === "<" || c === ">") {
        const redirect = readRedirect()
        if (redirect) redirects.push(redirect)
        continue
      }
      if (/[0-9]/.test(c) && /^[0-9]+[<>]/.test(text.slice(i))) {
        // stream-numbered redirect (2>, 2>&1, …): digits are part of the op, not an argument
        const digits = /^[0-9]+/.exec(text.slice(i))![0]
        i += digits.length
        const redirect = readRedirect()
        if (redirect) {
          redirect.op = digits + redirect.op
          redirects.push(redirect)
        }
        continue
      }
      if (c === "`" && text[i + 1] === "\n") {
        i += 2
        continue
      }
      if (c === "(") {
        // argument-position group — dynamic
        const group = captureSubexpressionLikeParen()
        subs.push(group)
        words.push(word("", true, false))
        continue
      }
      if (c === "{") throw new ParseError("ps-scriptblock")
      if (c === "'" || c === '"') {
        const wasDq = c === '"'
        const r = wasDq ? readDoubleQuoted() : readSingleQuoted()
        if (r.subs) subs.push(...r.subs)
        words.push({ kind: "word", value: r.value, quoted: true, dynamic: r.dynamic })
        continue
      }
      // bare word (backtick escapes the next char — including quotes — into the word)
      let value = ""
      let dynamic = false
      while (i < n && !/[\s,;|&#<>(){}"']/.test(text[i])) {
        if (text[i] === "`") {
          const e = text[i + 1]
          if (e === "\n") break
          value += backtickChar(e)
          i += 2
          continue
        }
        if (text[i] === "$") dynamic = true
        value += text[i]
        i++
      }
      if (value === "" && text[i] === "`") {
        i++
        continue
      }
      words.push(word(value, dynamic, true))
    }
    return finish()
  }

  function captureSubexpressionLikeParen(): string {
    let depth = 1
    let j = i + 1
    while (j < n && depth > 0) {
      if (text[j] === "(") depth++
      if (text[j] === ")") depth--
      j++
    }
    if (depth > 0) throw new ParseError("unterminated-substitution")
    const inner = text.slice(i + 1, j - 1)
    i = j
    return inner
  }

  function readRedirect(): SimpleCommand["redirects"][number] | null {
    // at < or >
    let op = text[i]
    i++
    if (text[i] === ">" && (op === ">" || op === "2" || op === "*")) {
      op += ">"
      i++
      if (text[i] === "&") {
        op += "&"
        i++
      }
    } else if (text[i] === "&") {
      op += "&"
      i++
    }
    skipSpaces()
    if (i < n && !/[\s,;|&#<>()"'`]/.test(text[i])) {
      const target = readValueToken()
      return { op, target: word(target.value, target.dynamic, true) }
    }
    return null
  }
}

function backtickChar(e: string | undefined): string {
  switch (e) {
    case "n": return "\n"
    case "t": return "\t"
    case "r": return "\r"
    case "0": return "\0"
    case "a": return "\x07"
    case "b": return "\b"
    case "e": return "\x1b"
    case "f": return "\f"
    case "v": return "\v"
    default: return e ?? ""
  }
}

/** Program-name gate shared with the classifier (compound/dynamic-exec). */
export function psProgramSuspense(program: string): ParseError | null {
  const name = program.toLowerCase()
  if (COMPOUND.has(name)) return new ParseError("ps-compound", `PowerShell \`${name}\` statement`)
  if (DYNAMIC_EXEC.has(name)) return new ParseError("invoke-expression", "Invoke-Expression executes strings dynamically")
  return null
}
