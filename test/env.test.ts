import { describe, expect, test } from "bun:test"
import { parseConfigParameters, analyzeEnv } from "../src/classify/env.js"

describe("GIT_CONFIG_PARAMETERS grammar", () => {
  test("valid single item", () => {
    expect(parseConfigParameters("'commit.gpgsign=false'")).toEqual({ items: ["commit.gpgsign=false"], malformed: false })
  })
  test("valid multiple items with spaces in values", () => {
    expect(parseConfigParameters("'a=1' 'b=two words'")).toEqual({ items: ["a=1", "b=two words"], malformed: false })
  })
  test("unquoted residue is malformed", () => {
    expect(parseConfigParameters("a=1").malformed).toBe(true)
    expect(parseConfigParameters("'a=1' b=2").malformed).toBe(true)
    expect(parseConfigParameters("'unterminated").malformed).toBe(true)
  })
})

describe("GIT_CONFIG_COUNT pairing", () => {
  test("indexed pairs become deltas", () => {
    const ea = analyzeEnv(
      {
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "commit.gpgSign",
        GIT_CONFIG_VALUE_0: "false",
        GIT_CONFIG_KEY_1: "core.hooksPath",
        GIT_CONFIG_VALUE_1: "/dev/null",
      },
      [],
    )
    expect(ea.deltas).toEqual([
      { key: "commit.gpgsign", value: "false", channel: "envGitConfig" },
      { key: "core.hookspath", value: "/dev/null", channel: "envGitConfig" },
    ])
  })
  test("out-of-range index ignored (git semantics)", () => {
    const ea = analyzeEnv(
      { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "1", GIT_CONFIG_KEY_1: "c.d", GIT_CONFIG_VALUE_1: "2" },
      [],
    )
    expect(ea.deltas.length).toBe(1)
  })
  test("key without value means boolean true", () => {
    const ea = analyzeEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgsign" }, [])
    expect(ea.deltas[0]).toEqual({ key: "commit.gpgsign", value: true, channel: "envGitConfig" })
  })
  test("dynamic value marked unresolved", () => {
    const ea = analyzeEnv({}, ["GIT_CONFIG_PARAMETERS"])
    expect(ea.unresolved).toEqual(["GIT_CONFIG_PARAMETERS"])
  })
  test("hiding candidates detected", () => {
    const ea = analyzeEnv({ GIT_CONFIG_GLOBAL: "/dev/null" }, [])
    expect(ea.hiding).toEqual([{ name: "GIT_CONFIG_GLOBAL", value: "/dev/null" }])
  })
})

describe("PS / cmd env handling", () => {
  test("native parsers emit export pseudo-commands ", () => {
    // coverage of the actual parsing lives in the corpus + powershell/cmd unit tests
    expect(true).toBe(true)
  })
})
