import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import plugin from "../src/plugin.js"
import { classifyResources } from "../src/classify/shell.js"
import { defaultConfig } from "../src/config.js"
import { createFixtureState } from "../src/state.js"
import { createFixtureRepo } from "../src/repo.js"

const signing = "$env:GIT_CONFIG_COUNT='1'; $env:GIT_CONFIG_KEY_0='commit.gpgsign'; $env:GIT_CONFIG_VALUE_0='false'; git commit --dry-run --allow-empty -m \"Guard env injection test\""
const hooks = "$env:GUARD_TEST_HOOKS='NUL'; git --config-env=core.hooksPath=GUARD_TEST_HOOKS commit --dry-run --allow-empty -m \"Guard config-env test\""

function deps() {
  return {
    cfg: defaultConfig(),
    st: createFixtureState([{ tag: "global", entries: { "commit.gpgsign": "true" } }]),
    repo: createFixtureRepo({ root: "G:/repo", gitDir: "G:/repo/.git" }),
  }
}

const directory = mkdtempSync(join(tmpdir(), "git-integrity-env-"))
const init = spawnSync("git", ["init", directory], { encoding: "utf8" })
if (init.status !== 0) throw new Error(init.stderr)
writeFileSync(join(directory, ".git", "config"), "[core]\nrepositoryformatversion = 0\n[commit]\ngpgsign = true\n")
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function harness() {
  const hooks: Record<string, (event: any) => void> = {}
  const cleanup = await plugin.setup({
    location: { directory },
    permission: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} } } },
    tool: { hook: async (name, cb) => { hooks[name] = cb; return { dispose: async () => {} } } },
  })
  function before(command: string, id = "call-a", sessionID = "ses-a", messageID = "msg-a") {
    hooks["execute.before"]({ tool: "shell", sessionID, messageID, id, input: { command } })
  }
  function evaluate(resource: string, id = "call-a", sessionID = "ses-a", messageID = "msg-a") {
    const event = { action: "shell", resources: [resource], sessionID, source: { type: "tool", messageID, id }, effect: "allow", message: "" }
    hooks.evaluate(event)
    return event
  }
  return { hooks, before, evaluate, cleanup }
}

for (const [command, invariant] of [[signing, "commit.signing.must-stay-enabled"], [hooks, "hooks.config.frozen"]]) {
  test(`native permission hook with assignments omitted: ${invariant}`, async () => {
    const h = await harness()
    try {
      h.before(command)
      const event = h.evaluate(command.split("; ").at(-1)!)
      expect(event.effect).toBe("deny")
      expect(event.message).toContain(invariant)
    } finally { await h.cleanup() }
  })
}

test("full scripts are isolated by call, session, and message; after hooks clean up", async () => {
  const h = await harness()
  try {
    h.before(signing)
    h.before("git status", "call-b")
    expect(h.evaluate("git status", "call-b").effect).toBe("allow")
    expect(h.evaluate("git status", "call-a", "ses-b").effect).toBe("allow")
    expect(h.evaluate("git status", "call-a", "ses-a", "msg-b").effect).toBe("allow")
    expect(h.evaluate("git commit --dry-run").effect).toBe("deny")
    h.hooks["execute.after"]({ tool: "shell", sessionID: "ses-a", messageID: "msg-a", id: "call-a", status: "error" })
    expect(h.evaluate("git commit --dry-run").effect).toBe("allow")
  } finally { await h.cleanup() }
})

test("permission resources still enforce changes made after script capture", async () => {
  const h = await harness()
  try {
    h.before("git status")
    expect(h.evaluate("git commit --no-verify --dry-run").effect).toBe("deny")
  } finally { await h.cleanup() }
})

test("truncated --config-env resource still resolves the full script", async () => {
  const h = await harness()
  try {
    h.before(hooks)
    const event = h.evaluate("git --config-env")
    expect(event.effect).toBe("deny")
    expect(event.message).toContain("hooks.config.frozen")
  } finally { await h.cleanup() }
})

test("capturing a shell script does not make an early throw-to-block decision", async () => {
  const h = await harness()
  try {
    expect(() => h.before(signing)).not.toThrow()
    await h.cleanup()
    expect(h.evaluate("git status").effect).toBe("allow")
  } finally { await h.cleanup() }
})

for (const [command, invariant] of [[signing, "commit.signing.must-stay-enabled"], [hooks, "hooks.config.frozen"]]) {
  test(`whole PowerShell script: ${invariant}`, () => {
    expect(classifyResources([command], deps())).toMatchObject({ decision: "deny", finding: { invariantId: invariant } })
  })
}
