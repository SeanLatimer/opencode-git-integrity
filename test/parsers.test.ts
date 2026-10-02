// Parser unit tests: PowerShell + cmd dialects.

import { describe, expect, test } from "bun:test"
import { parsePowerShell } from "../src/parse/powershell.js"
import { parseCmd } from "../src/parse/cmd.js"
import { ParseError } from "../src/types.js"

function programs(cmds: ReturnType<typeof parsePowerShell>) {
  return cmds.map((c) => c.words[0]?.value)
}

describe("PowerShell parser", () => {
  test("$env assignments become export pseudo-commands", () => {
    const cmds = parsePowerShell("$env:A='1'; $env:B=\"two\"; git commit -m x")
    expect(programs(cmds)).toEqual(["export", "export", "git"])
    expect(cmds[0].words[1].value).toBe("A=1")
    expect(cmds[1].words[1].value).toBe("B=two")
  })

  test("non-exported variable assignments are skipped", () => {
    const cmds = parsePowerShell('$x = "git"; git status')
    expect(programs(cmds)).toEqual(["git"])
  })

  test("call operator invokes the wrapped program", () => {
    const cmds = parsePowerShell('& "C:\\Program Files\\Git\\cmd\\git.exe" commit --no-verify')
    expect(cmds[0].words[0].value).toBe("C:\\Program Files\\Git\\cmd\\git.exe")
    expect(cmds[0].words[0].quoted).toBe(true)
    expect(cmds[0].words.map((w) => w.value).slice(1)).toEqual(["commit", "--no-verify"])
  })

  test("double quotes with variables are dynamic, literals are not", () => {
    const cmds = parsePowerShell('git commit -m "plain data --no-verify"')
    expect(cmds[0].words[3].dynamic).toBe(false)
    const dyn = parsePowerShell('git commit -m "$msg"')
    expect(dyn[0].words[3].dynamic).toBe(true)
  })

  test("double-quoted $() captures a substitution", () => {
    const cmds = parsePowerShell('git commit -m "$(git log -1 --format=%B)"')
    expect(cmds[0].substitutions).toEqual(["git log -1 --format=%B"])
    expect(cmds[0].words[3].dynamic).toBe(true)
  })

  test("backtick escapes are literal, not dynamic", () => {
    const cmds = parsePowerShell("git commit --amend -m `\"reword`\"")
    expect(cmds[0].words.length).toBeGreaterThan(0)
    const withTick = cmds[0].words.find((w) => w.value.includes("reword"))
    expect(withTick?.dynamic).toBe(false)
  })

  test("comma-separated arguments split into separate words", () => {
    const cmds = parsePowerShell('Start-Process git -ArgumentList "commit","--no-verify"')
    expect(cmds[0].words.map((w) => w.value)).toEqual(["Start-Process", "git", "-ArgumentList", "commit", "--no-verify"])
  })

  test("pipelines and separators split commands", () => {
    const cmds = parsePowerShell("git tag -n5 | Out-Null; git status && echo done")
    expect(programs(cmds)).toEqual(["git", "Out-Null", "git", "echo"])
  })

  test("redirects collected (incl. stream-numbered)", () => {
    const cmds = parsePowerShell("git push --no-verify 2>&1")
    expect(cmds[0].redirects).toEqual([{ op: "2>&", target: { kind: "word", value: "1", quoted: false, dynamic: false } }])
    expect(cmds[0].words.map((w) => w.value)).toEqual(["git", "push", "--no-verify"])
  })

  test("comments are ignored", () => {
    const cmds = parsePowerShell("<# note #> git status # trailing")
    expect(programs(cmds)).toEqual(["git"])
  })

  test("compound statements throw", () => {
    expect(() => parsePowerShell("if ($true) { git commit --no-verify }")).toThrow(ParseError)
    expect(() => parsePowerShell("foreach ($f in $files) { rm $f }")).toThrow(ParseError)
  })

  test("Invoke-Expression throws (dynamic execution)", () => {
    expect(() => parsePowerShell('iex "git commit --no-verify"')).toThrow(ParseError)
    expect(() => parsePowerShell('Invoke-Expression "x"')).toThrow(ParseError)
  })

  test("here-strings and scriptblocks throw", () => {
    expect(() => parsePowerShell('@"multiline"@')).toThrow(ParseError)
    expect(() => parsePowerShell("& { git commit }")).toThrow(ParseError)
  })
})

describe("cmd parser", () => {
  test("set statements become exports, && splits", () => {
    const cmds = parseCmd("set GIT_CONFIG_COUNT=1&& set GIT_CONFIG_KEY_0=core.hooksPath&& git commit -m x")
    expect(programs(cmds)).toEqual(["export", "export", "git"])
    expect(cmds[0].words[1].value).toBe("GIT_CONFIG_COUNT=1")
  })

  test("trailing space in set value trimmed", () => {
    const cmds = parseCmd("set X=1 && git status")
    expect(cmds[0].words[1].value).toBe("X=1")
  })

  test("%VAR% marks words dynamic", () => {
    const cmds = parseCmd("echo %PATH%")
    expect(cmds[0].words[1].dynamic).toBe(true)
  })

  test("caret escapes keep the word and statement together", () => {
    const cmds = parseCmd("echo done ^& git commit --no-verify")
    expect(cmds.length).toBe(1)
    expect(programs(cmds)).toEqual(["echo"])
  })

  test("quoted strings are literal", () => {
    const cmds = parseCmd('git commit -m "use --no-verify next time"')
    expect(cmds[0].words.map((w) => w.value)).toEqual(["git", "commit", "-m", "use --no-verify next time"])
  })

  test("if blocks throw (fail-closed)", () => {
    expect(() => parseCmd("if exist x del .git\\config")).toThrow(ParseError)
  })

  test("rem lines skipped", () => {
    const cmds = parseCmd("rem setup\r\ngit status")
    expect(programs(cmds)).toEqual(["git"])
  })

  test("redirects collected (incl. stream-numbered)", () => {
    const cmds = parseCmd("git commit --no-verify > out.txt 2>&1")
    expect(cmds[0].redirects.map((r) => r.op)).toEqual([">", "2>&"])
    expect(cmds[0].words.map((w) => w.value)).toEqual(["git", "commit", "--no-verify"])
  })
})
