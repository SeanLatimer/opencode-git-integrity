// cmd.exe parser . Statement model: `&` `&&` `||` `|` and
// newlines as separators, `set NAME=value` → `export` pseudo-command (env
// coupling is order-correct), REM/:: comments, caret (`^`) escapes, `%VAR%`
// and `!VAR!` expansion markers (dynamic), double-quote toggling, redirects.
// Compound constructs (if/for/parenthesized blocks) are rejected so the
// fail-mode gate applies — their bodies stay opaque to us by design.

import { ParseError, SimpleCommand, Word } from "../types.js"

const COMPOUND = new Set(["if", "for"])

export function parseCmd(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = []
  let i = 0
  const n = text.length

  const skipSeparators = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\r" || text[i] === "\n")) i++
  }

  while (true) {
    skipSeparators()
    if (i >= n) break

    // comments
    const rest = text.slice(i)
    if (/^(rem(\s|$)|::)/i.test(rest)) {
      const lineEnd = text.indexOf("\n", i)
      i = lineEnd === -1 ? n : lineEnd
      continue
    }

    const cmd = readCommand()
    if (!cmd) continue
    const program = cmd.words[0].value.toLowerCase()
    if (COMPOUND.has(program)) throw new ParseError("cmd-compound", `cmd \`${program}\` block`)
    if (program === "set") {
      const arg = cmd.words[1]
      if (arg && /^[A-Za-z_][A-Za-z0-9_]*=/.test(arg.value)) {
        commands.push({
          assignments: [],
          words: [word("export", false, true), word(arg.value.replace(/\s+$/, ""), arg.dynamic, true)],
          redirects: [],
          substitutions: [],
          raw: `export ${arg.value}`,
        })
      }
      // `set` alone or `set X` (query) — no env effect
      continue
    }
    commands.push(cmd)
  }
  return commands

  function word(value: string, dynamic: boolean, bare: boolean): Word {
    return { kind: "word", value, quoted: !bare, dynamic }
  }

  function readCommand(): SimpleCommand | null {
    const words: Word[] = []
    const redirects: SimpleCommand["redirects"] = []
    const subs: string[] = []
    let inQuotes = false

    const finish = (): SimpleCommand | null => {
      if (words.length === 0) return null
      return {
        assignments: [],
        words,
        redirects,
        substitutions: subs,
        raw: words.map((w) => (w.quoted ? `"${w.value}"` : w.value)).join(" "),
      }
    }

    while (i < n) {
      const c = text[i]
      if (c === '"') {
        inQuotes = !inQuotes
        i++
        continue
      }
      if (!inQuotes && (c === " " || c === "\t" || c === "\r" || c === "," || c === ";" || c === "\n")) {
        i++
        if (c === "\n" || c === ";") return finish()
        continue
      }
      if (!inQuotes && (c === "&" || c === "|")) {
        if (text.slice(i, i + 2) === "&&" || text.slice(i, i + 2) === "||") i += 2
        else i++
        return finish()
      }
      if (!inQuotes && (c === "<" || c === ">")) {
        let op = c
        i++
        if (text[i] === ">") {
          op += ">"
          i++
        }
        if (text[i] === "&") {
          op += "&"
          i++
        }
        while (i < n && text[i] === " ") i++
        let value = ""
        let dynamic = false
        while (i < n && !/[\s&|<>"]/i.test(text[i])) {
          if (text[i] === "%") dynamic = markVar(i)
          value += text[i]
          i++
        }
        redirects.push({ op, target: word(value, dynamic, true) })
        continue
      }
      if (!inQuotes && /[0-9]/.test(c) && /^[0-9]+[<>]/.test(text.slice(i))) {
        // stream-numbered redirect (2>, 2>&1): digits belong to the op
        const digits = /^[0-9]+/.exec(text.slice(i))![0]
        i += digits.length
        let op = digits
        if (text[i] === ">") {
          op += ">"
          i++
        }
        if (text[i] === "&") {
          op += "&"
          i++
        }
        while (i < n && text[i] === " ") i++
        let value = ""
        let dynamic = false
        while (i < n && !/[\s&|<>"]/i.test(text[i])) {
          if (text[i] === "%") dynamic = markVar(i)
          value += text[i]
          i++
        }
        redirects.push({ op, target: word(value, dynamic, true) })
        continue
      }
      if (!inQuotes && c === "(") throw new ParseError("cmd-group")
      // word accumulation (^ escapes the next char, including separators, into this word)
      let value = ""
      let dynamic = false
      while (i < n) {
        const ch = text[i]
        if (ch === '"') break
        if (!inQuotes && /[\s,;&|<>()]/.test(ch)) break
        if (ch === "^") {
          const e = text[i + 1]
          if (e === "\n") {
            i += 2
            continue
          }
          value += e ?? ""
          i += 2
          continue
        }
        if (ch === "%") dynamic = markVar(i) || dynamic
        if (ch === "!") dynamic = true
        value += ch
        i++
      }
      if (value !== "") words.push(word(value, dynamic, true))
    }
    return finish()
  }

  /** True when a %VAR% pair starts at position p. */
  function markVar(p: number): boolean {
    const close = text.indexOf("%", p + 1)
    return close !== -1 && close > p + 1
  }
}
