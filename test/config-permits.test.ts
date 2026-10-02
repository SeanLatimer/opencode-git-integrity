// M4 unit tests: config subcommand parsing, permits, drift via corpus.

import { describe, expect, test } from "bun:test"
import { parseConfigSubcommand, configActionToDeltas } from "../src/git/configSub.js"
import { parseGitInvocation } from "../src/git/argv.js"
import { buildCommands } from "../src/parse/commands.js"
import { lex } from "../src/parse/lexer.js"
import { permitCovers, armPendingPermit, parseTokens } from "../src/permits.js"
import { detectManagers } from "../src/classify/managers.js"
import { createFixtureState } from "../src/state.js"

function configAction(command: string) {
  const cmds = buildCommands(lex(command, { windowsPaths: false }))
  const gi = parseGitInvocation(cmds[0], command)!
  return parseConfigSubcommand(gi)
}

describe("git config subcommand parsing", () => {
  test("classic set forms", () => {
    expect(configAction("git config commit.gpgsign false")).toMatchObject({ kind: "set", key: "commit.gpgsign", value: "false", scope: "local" })
    expect(configAction("git config --global core.hooksPath /dev/null")).toMatchObject({ kind: "set", key: "core.hookspath", scope: "global" })
    expect(configAction('git config alias.x "commit --no-verify"')).toMatchObject({ kind: "set", key: "alias.x" })
  })
  test("read forms", () => {
    expect(configAction("git config --get core.hooksPath")).toMatchObject({ kind: "read" })
    expect(configAction("git config --list")).toMatchObject({ kind: "read" })
    expect(configAction("git config commit.gpgsign")).toMatchObject({ kind: "read" })
    expect(configAction("git config --get-regexp ^alias")).toMatchObject({ kind: "read" })
  })
  test("unset forms", () => {
    expect(configAction("git config --unset core.hooksPath")).toMatchObject({ kind: "unset", key: "core.hookspath" })
    expect(configAction("git config unset core.hooksPath")).toMatchObject({ kind: "unset", key: "core.hookspath" })
  })
  test("new-style set", () => {
    expect(configAction("git config set commit.gpgsign false")).toMatchObject({ kind: "set", key: "commit.gpgsign", value: "false" })
  })
  test("unset deltas carry the unset flag", () => {
    const deltas = configActionToDeltas({ kind: "unset", key: "core.hookspath", scope: "local" })
    expect(deltas[0]).toMatchObject({ key: "core.hookspath", unset: true, channel: "configSub" })
  })
  test("remove-section core maps to hooksPath unset", () => {
    expect(configActionToDeltas({ kind: "remove-section", section: "core", scope: "local" })[0]).toMatchObject({
      key: "core.hookspath",
      unset: true,
    })
  })
})

describe("permits", () => {
  test("env domains and exact ids", () => {
    process.env.OPENCODE_GIT_GUARD_PERMIT = "hooks,signing"
    try {
      expect(permitCovers("commit.hooks.must-run").covered).toBe(true)
      expect(permitCovers("tag.signing.must-stay-enabled").covered).toBe(true)
      expect(permitCovers("hooks.files.protected").covered).toBe(true) // hooks domain includes it
      expect(permitCovers("git.metadata.protected").covered).toBe(false) // files domain, not granted
      expect(permitCovers("plumbing.suspicious").covered).toBe(false)
    } finally {
      delete process.env.OPENCODE_GIT_GUARD_PERMIT
    }
  })
  test("pending permits are one-shot and expiring", () => {
    armPendingPermit("ses-x", parseTokens("signing"))
    expect(permitCovers("commit.signing.must-stay-enabled", "ses-x")).toMatchObject({ covered: true, consumed: true })
    expect(permitCovers("commit.signing.must-stay-enabled", "ses-x").covered).toBe(false) // consumed
  })
  test("all token", () => {
    armPendingPermit("ses-y1", parseTokens("all"))
    expect(permitCovers("parse.failed", "ses-y1").covered).toBe(true)
    armPendingPermit("ses-y2", parseTokens("all"))
    expect(permitCovers("git.scope.shift", "ses-y2").covered).toBe(true)
  })
})

describe("manager detection", () => {
  test("markers and config references", () => {
    const withHusky = createFixtureState([{ tag: "local", entries: { "core.hookspath": ".husky/_/h" } }])
    expect(detectManagers("G:/repo", withHusky).has("husky")).toBe(true)
    const withHk = createFixtureState([{ tag: "local", entries: { "hook.hk.command": "hk run --hook" } }], { existing: ["G:/repo/hk.pkl"] })
    const hk = detectManagers("G:/repo", withHk)
    expect(hk.has("hk")).toBe(true)
    const none = createFixtureState([{ tag: "local", entries: { "user.name": "x" } }])
    expect(detectManagers("G:/repo", none).size).toBe(0)
  })
})
