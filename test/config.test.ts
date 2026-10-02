import { describe, expect, test } from "bun:test"
import { loadConfig, defaultConfig, DEFAULT_POLICY } from "../src/config.js"

describe("config loading", () => {
  test("defaults match plan §7", () => {
    const cfg = defaultConfig()
    expect(cfg.enabled).toBe(true)
    expect(cfg.failMode).toBe("closed")
    expect(DEFAULT_POLICY["commit.hooks.must-run"]).toBe("deny")
    expect(DEFAULT_POLICY["tag.signing.must-stay-enabled"]).toBe("ask")
    expect(DEFAULT_POLICY["hooks.config.frozen"]).toBe("deny")
    // resolved policy map holds only explicit overrides; evaluator levels are the defaults
    expect(cfg.policy).toEqual({})
  })

  test("plugin options are user scope: full power", () => {
    const { config } = loadConfig({ policy: { "commit.hooks.must-run": "ask" }, failMode: "open", enabled: false })
    expect(config.policy["commit.hooks.must-run"]).toBe("ask")
    expect(config.failMode).toBe("open")
    expect(config.enabled).toBe(false)
  })

  test("unknown option keys warn", () => {
    const { warnings } = loadConfig({ bogus: 1 })
    expect(warnings.some((w) => w.includes("bogus"))).toBe(true)
  })

  test("invalid policy values warn and are ignored", () => {
    const { config, warnings } = loadConfig({ policy: { "commit.hooks.must-run": "yes" as any } })
    expect(config.policy["commit.hooks.must-run"]).toBeUndefined()
    expect(warnings.length).toBeGreaterThan(0)
  })
})
