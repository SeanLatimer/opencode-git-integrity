// Token stream → SimpleCommand[]. Splits on separators (; & && | || newline),
// recurses into (subshells), collects assignment prefixes and redirects, and
// rejects compound constructs (if/case/while/…) with ParseError so the caller
// can apply its fail-mode posture.

import { Assignment, ParseError, Redirect, SimpleCommand, Token, Word } from "../types.js"

const ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

// `!` and `time` are pipeline modifiers we drop (the command still runs);
// everything else here means a compound construct we refuse to guess at.
const DROP_PREFIX = new Set(["!", "time"])
const RESERVED = new Set([
  "if",
  "then",
  "elif",
  "else",
  "fi",
  "while",
  "until",
  "for",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "coproc",
  "{",
  "}",
  "[[",
  "]]",
])

const REDIRECT_OP_CHARS = new Set(["<", ">"])

export function buildCommands(tokens: Token[]): SimpleCommand[] {
  return parseSequence(tokens, 0, tokens.length)
}

function parseSequence(tokens: Token[], start: number, end: number): SimpleCommand[] {
  const out: SimpleCommand[] = []
  let assignments: Assignment[] = []
  let words: Word[] = []
  let redirects: Redirect[] = []
  let substitutions: string[] = []

  const flush = () => {
    // Assignment-only "commands" are shell variable sets (not exported, not env) — dropped.
    if (words.length > 0) {
      out.push({
        assignments,
        words,
        redirects,
        substitutions,
        raw: words.map((w) => (w.quoted ? `"${w.value}"` : w.value)).join(" "),
      })
    }
    assignments = []
    words = []
    redirects = []
    substitutions = []
  }

  let i = start
  while (i < end) {
    const t = tokens[i]
    if (t.kind === "word") {
      if (words.length === 0 && !t.quoted && !t.dynamic && DROP_PREFIX.has(t.value)) {
        i++
        continue
      }
      if (words.length === 0 && !t.quoted && RESERVED.has(t.value)) {
        throw new ParseError("compound", `compound construct \`${t.value}\``)
      }
      if (words.length === 0 && assignments.length >= 0 && !t.quoted && ASSIGN_RE.test(t.value)) {
        const eq = t.value.indexOf("=")
        assignments.push({
          name: t.value.slice(0, eq),
          value: t.value.slice(eq + 1),
          dynamic: t.dynamic,
        })
      } else {
        words.push(t)
      }
      if (t.subs) substitutions.push(...t.subs)
      i++
      continue
    }
    if (t.kind === "newline") {
      flush()
      i++
      continue
    }
    // operators
    if (t.op === "(") {
      if (words.length > 0) throw new ParseError("function-def")
      flush()
      let depth = 1
      let j = i + 1
      while (j < end) {
        const u = tokens[j]
        if (u.kind === "op" && u.op === "(") depth++
        if (u.kind === "op" && u.op === ")") {
          depth--
          if (depth === 0) break
        }
        j++
      }
      if (j >= end) throw new ParseError("unbalanced-paren")
      out.push(...parseSequence(tokens, i + 1, j))
      i = j + 1
      continue
    }
    if (t.op === ")") throw new ParseError("unbalanced-paren")
    if ([...t.op].some((ch) => REDIRECT_OP_CHARS.has(ch))) {
      const target = tokens[i + 1]
      if (!target || target.kind !== "word") throw new ParseError("redirect-missing-target")
      redirects.push({ op: t.op, target })
      if (target.subs) substitutions.push(...target.subs)
      i += 2
      continue
    }
    // ; & && | || — separators
    flush()
    i++
  }
  flush()
  return out
}
