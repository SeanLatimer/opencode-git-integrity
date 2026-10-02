import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { classifyResources } from "../src/classify/shell.js"
import { classifyCodeMode } from "../src/classify/codemode.js"
import { classifyEditResource } from "../src/classify/files.js"
import type { ManagerName } from "../src/classify/managers.js"
import { createFixtureState, OriginTag } from "../src/state.js"
import { createFixtureRepo } from "../src/repo.js"
import { defaultConfig } from "../src/config.js"
import type { Finding } from "../src/types.js"

function editDecision(finding?: Finding): { decision: "allow" | "ask" | "deny"; finding?: Finding } {
  return finding ? { decision: finding.level, finding } : { decision: "allow" }
}

type Case = {
  id: string
  kind?: "codemode" | "edit"
  command?: string
  code?: string
  state?: { files: Array<{ tag: OriginTag; entries: Record<string, string> }> }
  repo?: { root: string; gitDir: string; commonDir?: string; worktrees?: string[]; modules?: string[] }
  managers?: string[]
  aliases?: Record<string, string>
  snapshot?: { commitSigning: boolean; tagSigning: boolean; pushSigning: boolean; hooksPath?: string }
  guardPaths?: string[]
  config?: { failMode?: "open" | "closed"; policy?: Record<string, string>; protectSampleHooks?: boolean; strictAliases?: boolean }
  platform?: string[]
  expect: "allow" | "ask" | "deny"
  invariant?: string
  note?: string
  knownGap?: string
}

const lines = readFileSync(join(import.meta.dir, "..", "corpus", "corpus.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
const cases: Case[] = lines.map((l) => JSON.parse(l))

describe(`decision corpus (${cases.length} cases)`, () => {
  for (const c of cases) {
    const platformSkipped = !!c.platform && !c.platform.includes(process.platform)
    const runner = platformSkipped ? test.skip : test
    runner(`${c.id}${c.knownGap ? " [known gap]" : ""}${platformSkipped ? " [platform]" : ""}: ${c.command ?? c.code}`, () => {
      const cfg = defaultConfig()
      if (c.config?.failMode) cfg.failMode = c.config.failMode
      if (c.config?.policy) Object.assign(cfg.policy, c.config.policy)
      if (c.config?.protectSampleHooks !== undefined) cfg.protectSampleHooks = c.config.protectSampleHooks
      if (c.config?.strictAliases !== undefined) cfg.strictAliases = c.config.strictAliases
      const st = createFixtureState(c.state?.files ?? [], { root: "G:/repo", gitDir: "G:/repo/.git" })
      const repo = createFixtureRepo({ root: "G:/repo", gitDir: "G:/repo/.git", ...(c.repo ?? {}) })
      const deps = {
        cfg,
        st,
        repo,
        managers: new Set((c.managers ?? []) as ManagerName[]),
        aliases: c.aliases ?? {},
        snapshot: c.snapshot,
        expectedDrift: false,
        guardPaths: c.guardPaths,
      }
      const result =
        c.kind === "codemode"
          ? classifyCodeMode(c.code ?? "", deps)
          : c.kind === "edit"
            ? editDecision(classifyEditResource(c.command ?? "", repo, cfg, c.guardPaths))
            : classifyResources([c.command ?? ""], deps)
      expect(result.decision).toBe(c.expect)
      if (c.invariant) expect(result.finding?.invariantId).toBe(c.invariant)
    })
  }
})
