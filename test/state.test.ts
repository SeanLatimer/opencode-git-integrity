import { describe, expect, test } from "bun:test"
import { parseIni, createFixtureState, commitSigningEnabled, tagSigningEnabled, hooksPathCurrent, protectedFromOrigin } from "../src/state.js"
import { gitBool } from "../src/git/booleans.js"

describe("INI parsing", () => {
  test("sections, keys, quoting, comments", () => {
    const entries = parseIni(`
# comment
[user]
name = Sean
[commit]
gpgsign = true
[core]
hooksPath = ".husky"
; another comment
[tag]
forcesignannotated = 1
`)
    expect(entries["user.name"]).toBe("Sean")
    expect(entries["commit.gpgsign"]).toBe("true")
    expect(entries["core.hookspath"]).toBe(".husky")
    expect(entries["tag.forcesignannotated"]).toBe("1")
  })
})

describe("git booleans", () => {
  test("accepted forms", () => {
    expect(gitBool(true)).toBe(true)
    expect(gitBool("")).toBe(true)
    expect(gitBool("TRUE")).toBe(true)
    expect(gitBool("Yes")).toBe(true)
    expect(gitBool("on")).toBe(true)
    expect(gitBool("1")).toBe(true)
    expect(gitBool("false")).toBe(false)
    expect(gitBool("NO")).toBe(false)
    expect(gitBool("Off")).toBe(false)
    expect(gitBool("0")).toBe(false)
    expect(gitBool("maybe")).toBeNull()
    expect(gitBool(undefined)).toBeNull()
  })
})

describe("fixture state precedence and gates", () => {
  const st = createFixtureState(
    [
      { tag: "global", entries: { "commit.gpgsign": "true" } },
      { tag: "local", entries: { "core.hookspath": ".husky" } },
    ],
    { root: "G:/repo", gitDir: "G:/repo/.git" },
  )

  test("effective lookup crosses files", () => {
    expect(commitSigningEnabled(st)).toBe(true)
    expect(hooksPathCurrent(st)).toBe(".husky")
    expect(st.effective("commit.gpgsign")?.tag).toBe("global")
    expect(st.effective("core.hookspath")?.tag).toBe("local")
  })

  test("local overrides global for the same key", () => {
    const st2 = createFixtureState([
      { tag: "global", entries: { "tag.gpgsign": "true" } },
      { tag: "local", entries: { "tag.gpgsign": "false" } },
    ])
    expect(tagSigningEnabled(st2)).toBe(false)
  })

  test("origin gating for config-source hiding", () => {
    expect(protectedFromOrigin(st, "global")).toBe(true)
    expect(protectedFromOrigin(st, "system")).toBe(false)
    const stSys = createFixtureState([{ tag: "system", entries: { "commit.gpgsign": "true" } }])
    expect(protectedFromOrigin(stSys, "system")).toBe(true)
    // falsy protected keys do not count as "providing" settings
    const stFalsy = createFixtureState([{ tag: "global", entries: { "commit.gpgsign": "false" } }])
    expect(protectedFromOrigin(stFalsy, "global")).toBe(false)
    // flat [hook] config keys count
    const stHook = createFixtureState([{ tag: "global", entries: { "hook.ci.enabled": "true" } }])
    expect(protectedFromOrigin(stHook, "global")).toBe(true)
  })
})
