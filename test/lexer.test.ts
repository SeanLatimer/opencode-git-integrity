import { describe, expect, test } from "bun:test"
import { lex } from "../src/parse/lexer.js"
import { buildCommands } from "../src/parse/commands.js"
import { ParseError } from "../src/types.js"

function words(input: string) {
  return buildCommands(lex(input))
}

describe("lexer", () => {
  test("plain words and quoting metadata", () => {
    const tokens = lex("git commit -m 'hello world'")
    const kinds = tokens.map((t) => t.kind)
    expect(kinds).toEqual(["word", "word", "word", "word"])
    const last = tokens[3] as any
    expect(last.value).toBe("hello world")
    expect(last.quoted).toBe(true)
    expect(last.dynamic).toBe(false)
  })

  test("double quotes with variable are dynamic, value preserved", () => {
    const tokens = lex('echo "$HOME/x"')
    const word = tokens[1] as any
    expect(word.value).toBe("/x")
    expect(word.dynamic).toBe(true)
  })

  test("double quotes without expansions are literal", () => {
    const tokens = lex('echo "plain data --no-verify"')
    const word = tokens[1] as any
    expect(word.value).toBe("plain data --no-verify")
    expect(word.quoted).toBe(true)
    expect(word.dynamic).toBe(false)
  })

  test("escapes resolve and do not split words (POSIX mode)", () => {
    const tokens = lex("\\git commit\\ --no-verify", { windowsPaths: false })
    expect((tokens[0] as any).value).toBe("git")
    expect((tokens[1] as any).value).toBe("commit --no-verify")
  })

  test("backslashes are path separators in Windows mode", () => {
    const tokens = lex("del .git\\config", { windowsPaths: true })
    expect((tokens[1] as any).value).toBe(".git\\config")
  })

  test("operators split commands", () => {
    const cmds = words("a && b ; c | d || e & f")
    expect(cmds.map((c) => c.words[0].value)).toEqual(["a", "b", "c", "d", "e", "f"])
  })

  test("assignment prefix is captured separately", () => {
    const cmds = words("VAR=1 git commit")
    expect(cmds[0].assignments).toEqual([{ name: "VAR", value: "1", dynamic: false }])
    expect(cmds[0].words.map((w) => w.value)).toEqual(["git", "commit"])
  })

  test("assignment-looking args after the program stay args", () => {
    const cmds = words("git foo=bar")
    expect(cmds[0].assignments.length).toBe(0)
    expect(cmds[0].words[1].value).toBe("foo=bar")
  })

  test("quoted assignment word is not an assignment", () => {
    const cmds = words('"VAR=1" git')
    expect(cmds[0].assignments.length).toBe(0)
  })

  test("command substitution captured and marked dynamic", () => {
    const cmds = words("git commit -m \"$(git log -1)\"")
    expect(cmds[0].substitutions.length).toBe(1)
    expect(cmds[0].substitutions[0]).toBe("git log -1")
    const cmds2 = words("echo $(git status)")
    expect(cmds2[0].substitutions).toEqual(["git status"])
  })

  test("redirects collected with targets", () => {
    const cmds = words("echo x > .gitignore")
    expect(cmds[0].redirects).toEqual([{ op: ">", target: { kind: "word", value: ".gitignore", quoted: false, dynamic: false } }])
    expect(cmds[0].words.map((w) => w.value)).toEqual(["echo", "x"])
  })

  test("fd-prefixed redirect lexes as one op", () => {
    const cmds = words("git push 2>&1 | tee log")
    expect(cmds[0].redirects[0].op).toBe("2>&")
    expect(cmds[0].redirects[0].target.value).toBe("1")
  })

  test("subshell recurses into commands", () => {
    const cmds = words("(git commit --no-verify)")
    expect(cmds.map((c) => c.words[0].value)).toEqual(["git"])
  })

  test("negation and time prefixes are dropped", () => {
    const cmds = words("! git commit")
    expect(cmds[0].words[0].value).toBe("git")
    const cmds2 = words("time git push")
    expect(cmds2[0].words[0].value).toBe("git")
  })

  test("comments ignored", () => {
    const cmds = words("git commit # --no-verify mentioned in comment")
    expect(cmds[0].words.map((w) => w.value)).toEqual(["git", "commit"])
  })

  test("unterminated quote throws", () => {
    expect(() => lex("echo 'oops")).toThrow(ParseError)
  })

  test("heredoc throws", () => {
    expect(() => lex("cat <<EOF")).toThrow(ParseError)
  })

  test("case statement throws", () => {
    expect(() => lex("case x in a) y;; esac")).toThrow(ParseError)
  })

  test("compound if throws", () => {
    expect(() => words("if true; then git commit; fi")).toThrow(ParseError)
  })

  test("brace group throws", () => {
    expect(() => words("{ git commit ; }")).toThrow(ParseError)
  })

  test("export is a plain command the classifier recognizes", () => {
    const cmds = words("export GIT_CONFIG_COUNT=1")
    expect(cmds[0].words[0].value).toBe("export")
    expect(cmds[0].words[1].value).toBe("GIT_CONFIG_COUNT=1")
  })
})
