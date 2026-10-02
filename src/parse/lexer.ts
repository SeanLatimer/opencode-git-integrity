// POSIX-flavoured shell lexer. Produces typed tokens (words with quoting/dynamic
// metadata, operators, newlines) — never a re-splittable string. This is the
// foundation that makes all downstream checks token-precise rather than substring.
//
// Supported: quoting ('…', "…", \x, $'…'), operators (; & && | || () redirects),
// command/process substitution capture ($(…), `…`, <(…) >(…)), parameter
// expansions marked dynamic, comments, line continuations.
// Rejected (ParseError): heredocs, case (;;), unterminated quotes/substitutions.

import { ParseError, Token, Word } from "../types.js"

const BLANK = new Set([" ", "\t", "\r"])
const WORD_STOP = new Set([" ", "\t", "\r", "\n", ";", "&", "|", "(", ")", "<", ">"])

// On Windows the executing shell (PowerShell/cmd) treats backslashes as path
// separators, so unquoted `X\y` must keep the backslash instead of POSIX
// escape semantics. Explicitly overridable for tests; full cross-platform
// determinism is handled by the dialect parsers (powershell.ts / cmd.ts).
const WINDOWS_PATHS = process.platform === "win32"

export function lex(input: string, opts?: { windowsPaths?: boolean }): Token[] {
  const windowsPaths = opts?.windowsPaths ?? WINDOWS_PATHS
  const tokens: Token[] = []
  let i = 0
  const n = input.length

  while (i < n) {
    const c = input[i]
    if (BLANK.has(c)) {
      i++
      continue
    }
    if (c === "\\" && input[i + 1] === "\n") {
      i += 2
      continue
    }
    if (c === "\n") {
      tokens.push({ kind: "newline" })
      i++
      continue
    }
    if (c === "#") {
      while (i < n && input[i] !== "\n") i++
      continue
    }
    if (c === ";") {
      if (input[i + 1] === ";") throw new ParseError("case-statement")
      tokens.push({ kind: "op", op: ";" })
      i++
      continue
    }
    if (c === "&") {
      if (input[i + 1] === "&") {
        tokens.push({ kind: "op", op: "&&" })
        i += 2
        continue
      }
      if (input[i + 1] === ">") {
        tokens.push({ kind: "op", op: "&>" })
        i += 2
        continue
      }
      tokens.push({ kind: "op", op: "&" })
      i++
      continue
    }
    if (c === "|") {
      if (input[i + 1] === "|") {
        tokens.push({ kind: "op", op: "||" })
        i += 2
        continue
      }
      tokens.push({ kind: "op", op: "|" })
      i++
      continue
    }
    if (c === "(") {
      tokens.push({ kind: "op", op: "(" })
      i++
      continue
    }
    if (c === ")") {
      tokens.push({ kind: "op", op: ")" })
      i++
      continue
    }
    if ((c === "<" || c === ">") && input[i + 1] === "(") {
      // process substitution starts a word: <(cmd) / >(cmd)
      const word = scanWord(input, i, windowsPaths)
      tokens.push(word.token)
      i = word.next
      continue
    }
    if (c === "<" || c === ">") {
      const op = scanRedirectOp(input, i)
      tokens.push({ kind: "op", op: op.op })
      i = op.next
      continue
    }
    if (/[0-9]/.test(c) && (input[i + 1] === "<" || input[i + 1] === ">")) {
      // fd-prefixed redirect: 2> 2>> 1>&2 …
      let j = i
      while (j < n && /[0-9]/.test(input[j])) j++
      const op = scanRedirectOp(input, j)
      tokens.push({ kind: "op", op: input.slice(i, j) + op.op })
      i = op.next
      continue
    }
    const word = scanWord(input, i, windowsPaths)
    tokens.push(word.token)
    i = word.next
  }
  return tokens
}

/** Scans a redirect operator starting at input[i] ('<' or '>'). Heredocs throw. */
function scanRedirectOp(input: string, i: number): { op: string; next: number } {
  const n = input.length
  const c = input[i]
  if (c === "<") {
    if (input[i + 1] === "<") throw new ParseError("heredoc")
    if (input[i + 1] === "&") return { op: "<&", next: i + 2 }
    if (input[i + 1] === ">") return { op: "<>", next: i + 2 }
    return { op: "<", next: i + 1 }
  }
  if (input[i + 1] === ">") return { op: ">>", next: i + 2 }
  if (input[i + 1] === "&") return { op: ">&", next: i + 2 }
  if (input[i + 1] === "|") return { op: ">|", next: i + 2 }
  return { op: ">", next: i + 1 }
}

/**
 * Scans one word starting at input[i]. Returns the typed word and the index
 * after it. Words accumulate quoted segments, escapes, and dynamic parts;
 * substitutions ($(…), `…`, <(…) >(…)) are captured verbatim into subs.
 */
function scanWord(input: string, start: number, windowsPaths: boolean): { token: Word; next: number } {
  const n = input.length
  let i = start
  let value = ""
  let segments = 0
  let quotedSegments = 0
  let bareChars = 0
  let dynamic = false
  const subs: string[] = []

  while (i < n) {
    const c = input[i]
    if (BLANK.has(c) || c === "\n") break
    if (";&|()".includes(c)) break
    if (c === "<" || c === ">") {
      if (input[i + 1] === "(") {
        const cap = captureParen(input, i + 1)
        subs.push(cap.inner)
        dynamic = true
        segments++
        i = cap.next
        continue
      }
      break
    }
    if (c === "'") {
      const end = input.indexOf("'", i + 1)
      if (end === -1) throw new ParseError("unterminated-quote")
      value += input.slice(i + 1, end)
      segments++
      quotedSegments++
      i = end + 1
      continue
    }
    if (c === '"') {
      const closed = scanDoubleQuoted(input, i, subs)
      value += closed.text
      if (closed.dynamic) dynamic = true
      segments++
      quotedSegments++
      i = closed.next
      continue
    }
    if (c === "\\") {
      const e = input[i + 1]
      if (e === undefined) throw new ParseError("unterminated-escape")
      if (e === "\n") {
        i += 2
        continue
      }
      if (windowsPaths) {
        value += c + e // backslash is a path separator on Windows shells
      } else {
        value += e // POSIX escape
      }
      segments++
      bareChars++
      i += 2
      continue
    }
    if (c === "`") {
      const end = input.indexOf("`", i + 1)
      if (end === -1) throw new ParseError("unterminated-quote")
      subs.push(input.slice(i + 1, end))
      dynamic = true
      segments++
      i = end + 1
      continue
    }
    if (c === "$") {
      const d = scanDollar(input, i, subs)
      if (d.literal !== undefined) value += d.literal
      if (d.dynamic) dynamic = true
      if (d.quotedSegment) {
        segments++
        quotedSegments++
      } else {
        segments++
        if (d.dynamic) bareChars++ // unresolved segment — treat as bare for quoting purposes
      }
      i = d.next
      continue
    }
    value += c
    segments++
    bareChars++
    i++
  }

  return {
    token: {
      kind: "word",
      value,
      quoted: segments === 1 && quotedSegments === 1 && bareChars === 0,
      dynamic,
      subs: subs.length ? subs : undefined,
    },
    next: i,
  }
}

function scanDoubleQuoted(input: string, start: number, subs: string[]): { text: string; next: number; dynamic: boolean } {
  const n = input.length
  let i = start + 1
  let text = ""
  let dynamic = false
  while (i < n && input[i] !== '"') {
    const c = input[i]
    if (c === "\\") {
      const e = input[i + 1]
      if (e === undefined) throw new ParseError("unterminated-quote")
      if ("$`\"\n\\".includes(e)) {
        if (e !== "\n") text += e
        i += 2
        continue
      }
      text += c
      i++
      continue
    }
    if (c === "$") {
      const d = scanDollar(input, i, subs)
      if (d.literal !== undefined) text += d.literal
      if (d.dynamic) dynamic = true
      i = d.next
      continue
    }
    if (c === "`") {
      const end = input.indexOf("`", i + 1)
      if (end === -1) throw new ParseError("unterminated-quote")
      subs.push(input.slice(i + 1, end))
      dynamic = true
      i = end + 1
      continue
    }
    text += c
    i++
  }
  if (i >= n) throw new ParseError("unterminated-quote")
  return { text, next: i + 1, dynamic }
}

/**
 * Scans a $… construct at input[i] ('$'). Returns the next index, any literal
 * value it resolves to (never for dynamic forms), dynamic flag, and whether it
 * was a $'…' quoted segment.
 */
function scanDollar(input: string, i: number, subs: string[]): { next: number; literal?: string; dynamic: boolean; quotedSegment?: boolean } {
  const n = input.length
  const c = input[i + 1]
  if (c === "(") {
    const cap = captureParen(input, i + 1)
    subs.push(cap.inner)
    return { next: cap.next, dynamic: true }
  }
  if (c === "'") {
    // ANSI-C quoting: approximate as literal with escapes resolved
    let j = i + 2
    let text = ""
    while (j < n && input[j] !== "'") {
      if (input[j] === "\\" && j + 1 < n) {
        text += input[j + 1]
        j += 2
        continue
      }
      text += input[j]
      j++
    }
    if (j >= n) throw new ParseError("unterminated-quote")
    return { next: j + 1, literal: text, dynamic: false, quotedSegment: true }
  }
  if (c === "{") {
    let depth = 1
    let j = i + 2
    while (j < n && depth > 0) {
      if (input[j] === "$" && input[j + 1] === "{") {
        depth++
        j += 2
        continue
      }
      if (input[j] === "}") depth--
      j++
    }
    if (depth > 0) throw new ParseError("unterminated-expansion")
    return { next: j, dynamic: true }
  }
  if (c !== undefined && /[A-Za-z_]/.test(c)) {
    let j = i + 1
    while (j < n && /[A-Za-z0-9_]/.test(input[j])) j++
    return { next: j, dynamic: true }
  }
  if (c !== undefined && /[@#?!$*0-9\-]/.test(c)) {
    return { next: i + 2, dynamic: true }
  }
  // lone '$'
  return { next: i + 1, literal: "$", dynamic: false }
}

/** Captures the text between balanced parens starting at input[open] === '('. */
function captureParen(input: string, open: number): { inner: string; next: number } {
  const n = input.length
  let depth = 1
  let j = open + 1
  while (j < n) {
    const c = input[j]
    if (c === "'") {
      const end = input.indexOf("'", j + 1)
      if (end === -1) throw new ParseError("unterminated-quote")
      j = end + 1
      continue
    }
    if (c === '"') {
      let k = j + 1
      while (k < n && input[k] !== '"') {
        if (input[k] === "\\") k++
        k++
      }
      if (k >= n) throw new ParseError("unterminated-quote")
      j = k + 1
      continue
    }
    if (c === "\\") {
      j += 2
      continue
    }
    if (c === "(") depth++
    if (c === ")") {
      depth--
      if (depth === 0) return { inner: input.slice(open + 1, j), next: j + 1 }
    }
    j++
  }
  throw new ParseError("unterminated-substitution")
}
