// Integration runner — drives a real opencode v2.0.22 server through
// `opencode run --standalone` (isolation: private server, fresh
// plugins, background service untouched) against a scratch git repo, and
// asserts guard behaviour from the plugin's audit JSONL + repo side effects.
//
// Scenarios:
//   I1  shell flag bypass (--no-verify)              → native deny, commit blocked
//   I2a tag signing ask under --auto                 → ask approved once, tag created
//   I2b tag signing ask without --auto               → ask auto-rejected, tag absent
//   I3  FP control (-c core.pager=cat log)           → allow, command runs
//   I4  Code Mode Bun.spawnSync(["git", …, "--no-verify"]) → blocked via execute.before
//   I5  -c commit.gpgsign=false (global signing on)  → deny via effective-state gate
//
// Usage: bun test/integration/run.ts

import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, "..", "..")
let repoDir = join(here, "repo-m1")
let opencodeJsonPath = join(repoDir, "opencode.json")

type AuditLine = Record<string, any>

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Windows: a just-exited server/git child can hold the dir for a moment. */
async function removeWithRetry(dir: string): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return true
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "ENOTEMPTY" && error?.code !== "EPERM") throw error
      await sleep(300)
    }
  }
  return false
}

function sh(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const result = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", timeout: 300_000 })
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}` }
}

function git(args: string[]) {
  return sh("git", args, { cwd: repoDir })
}

function readAudit(path: string): AuditLine[] {
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

async function setupRepo() {
  // fresh dir per run: a just-exited server may briefly hold the previous dir
  // (Windows EBUSY), and `--session` adoption can bind to older runs' projects
  for (const stale of (existsSync(here) ? readdirSync(here) : [])) {
    if (stale.startsWith("repo-m1")) {
      try {
        rmSync(join(here, stale), { recursive: true, force: true })
      } catch {
        // locked — best effort, a later run will clean it
      }
    }
  }
  repoDir = join(here, `repo-m1-${Date.now() % 100000}`)
  opencodeJsonPath = join(repoDir, "opencode.json")
  mkdirSync(repoDir, { recursive: true })
  git(["init", "-b", "main"])
  git(["config", "user.email", "m1@test.local"])
  git(["config", "user.name", "Integration Test"])
  // the operator's global config has commit.gpgsign=true but a non-working
  // signer in this context: disable signing locally only for the fixture
  // commit, then unset so effective signing is on again (global true).
  git(["config", "commit.gpgsign", "false"])
  writeFileSync(join(repoDir, "track.txt"), "m1\n")
  git(["add", "track.txt"])
  git(["commit", "-m", "init"])
  git(["config", "--unset", "commit.gpgsign"])
  // fixtures: a real hook file and a known config content
  writeFileSync(join(repoDir, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n")
  writeFileSync(opencodeJsonPath, JSON.stringify({ plugins: [{ package: packageDir }] }, null, 2))
}

type Scenario = {
  id: string
  auto: boolean
  prompt: string
  prepare?: () => void
  env?: Record<string, string>
  assert: (audit: AuditLine[], runOutput: string) => string | null // null = pass
}

const scenarios: Scenario[] = [
  {
    id: "I1-deny-no-verify",
    auto: true,
    prompt: "Use the shell tool to run exactly this command and nothing else: git commit --no-verify -m \"it-1\"",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "commit.hooks.must-run")
      if (!d) return "no deny decision for commit.hooks.must-run in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      return null
    },
  },
  {
    id: "I2a-ask-approved",
    auto: true,
    prompt: "Use the shell tool to run exactly this command and nothing else: git tag --no-sign -a -m m1i2 it-2a",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "tag.signing.must-stay-enabled")
      if (!d) return "no ask decision for tag.signing.must-stay-enabled in audit"
      if (d.decision !== "ask") return `expected ask, got ${d.decision}`
      const tag = git(["tag", "-l", "it-2a"]).out.trim()
      if (tag !== "it-2a") return `expected tag it-2a to exist after --auto approval`
      return null
    },
  },
  {
    id: "I2b-ask-rejected",
    auto: false,
    prompt: "Use the shell tool to run exactly this command and nothing else: git tag --no-sign -a -m m1i2 it-2b",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "tag.signing.must-stay-enabled")
      if (!d) return "no ask decision in audit"
      if (d.decision !== "ask") return `expected ask, got ${d.decision}`
      const tag = git(["tag", "-l", "it-2b"]).out.trim()
      if (tag !== "") return `expected tag it-2b to be absent (headless ask is auto-rejected)`
      return null
    },
  },
  {
    id: "I3-allow-fp-control",
    auto: true,
    prompt: "Use the shell tool to run exactly this command and nothing else: git -c core.pager=cat log --oneline -3",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && Array.isArray(l.resources) && l.resources.some((r: string) => r.includes("core.pager=cat")))
      if (!d) return "no decision logged for the FP-control command"
      if (d.decision !== "allow") return `expected allow, got ${d.decision} (${d.invariant ?? ""})`
      return null
    },
  },
  {
    id: "I4-codemode-blocked",
    auto: true,
    prompt:
      'Use the execute tool (code mode) to run this exact JavaScript and nothing else: const p = Bun.spawnSync(["git","commit","--no-verify","-m","it-4"]); return p.exitCode',
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "codemode-decision" && l.invariant === "commit.hooks.must-run")
      if (!d) return "no codemode deny decision for commit.hooks.must-run in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      const head = git(["rev-parse", "HEAD"]).out.trim()
      const log = git(["log", "--oneline", "-1"]).out
      if (log.includes("it-4")) return "the blocked commit appears to have been created"
      void head
      return null
    },
  },
  {
    id: "I5-deny-config-override",
    auto: true,
    prompt:
      "Use the shell tool to run exactly this command and nothing else: git -c commit.gpgsign=false commit -m \"it-5\"",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "commit.signing.must-stay-enabled")
      if (!d) return "no deny decision for commit.signing.must-stay-enabled in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      const log = git(["log", "--oneline"]).out
      if (log.includes("it-5")) return "the blocked commit appears to have been created"
      return null
    },
  },
  {
    id: "I6-edit-git-config",
    auto: true,
    prompt: "Use the edit tool to edit the file .git/config: change the line reading [core] to [core2]. Nothing else.",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "git.metadata.protected")
      if (!d) return "no deny decision for git.metadata.protected in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      const config = readFileSync(join(repoDir, ".git", "config"), "utf8")
      if (config.includes("[core2]")) return ".git/config was modified despite the deny"
      return null
    },
  },
  {
    id: "I7-rm-hook-file",
    auto: true,
    prompt: "Use the shell tool to run exactly this command and nothing else: rm .git/hooks/pre-commit",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "hooks.files.protected")
      if (!d) return "no deny decision for hooks.files.protected in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      if (!existsSync(join(repoDir, ".git", "hooks", "pre-commit"))) return "hook file was deleted despite the deny"
      return null
    },
  },
  {
    id: "I9-config-mutation-denied",
    auto: true,
    prompt:
      "Use the shell tool to run exactly this command and nothing else: git config --local commit.gpgsign false",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "commit.signing.must-stay-enabled")
      if (!d) return "no deny decision for commit.signing.must-stay-enabled in audit"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      const config = readFileSync(join(repoDir, ".git", "config"), "utf8")
      if (/gpgsign\s*=\s*false/.test(config)) return ".git/config was mutated despite the deny"
      return null
    },
  },
  {
    id: "I10-env-permit-allows",
    auto: true,
    env: { OPENCODE_GIT_GUARD_PERMIT: "signing" },
    prompt:
      "Use the shell tool to run exactly this command and nothing else: git config --local commit.gpgsign false",
    assert: (audit) => {
      const permit = audit.find((l) => l.kind === "permit-applied")
      if (!permit) return "no permit-applied entry in audit"
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "commit.signing.must-stay-enabled")
      if (!d) return "expected the guard to still evaluate the finding (audit decision) before the permit"
      const config = readFileSync(join(repoDir, ".git", "config"), "utf8")
      if (!/gpgsign\s*=\s*false/.test(config)) return "permit did not allow the mutation through"
      return null
    },
  },
  {
    id: "I8-ps-call-operator",
    auto: true,
    prompt:
      "Use the shell tool to run exactly this command and nothing else: & git commit --no-verify -m it-8",
    assert: (audit) => {
      const d = audit.find((l) => l.kind === "decision" && l.invariant === "commit.hooks.must-run")
      if (!d) return "no deny decision for commit.hooks.must-run in audit (PS call-operator parse)"
      if (d.decision !== "deny") return `expected deny, got ${d.decision}`
      const log = git(["log", "--oneline"]).out
      if (log.includes("it-8")) return "the blocked commit appears to have been created"
      return null
    },
  },
]

async function run() {
  await setupRepo()
  const filter = process.argv[2]
  const active = filter ? scenarios.filter((s) => s.id.toLowerCase().includes(filter.toLowerCase())) : scenarios
  const baseHead = git(["rev-parse", "HEAD"]).out.trim()
  const failures: string[] = []
  const results: Array<{ id: string; status: string; detail?: string }> = []

  for (const scenario of active) {
    const auditPath = join(repoDir, "..", `audit-${scenario.id}.jsonl`)
    rmSync(auditPath, { force: true })
    scenario.prepare?.()
    const headBefore = git(["rev-parse", "HEAD"]).out.trim()

    const runResult = sh(
      "opencode",
      [
        "run",
        "--standalone",
        // unique session per scenario per run: fixed IDs adopt the stored
        // session's project directory from earlier runs, bypassing cwd
        "--session",
        `ses-m1-${scenario.id.toLowerCase()}-${Date.now() % 100000}`,
        ...(scenario.auto ? ["--auto"] : []),
        scenario.prompt,
      ],
      {
        cwd: repoDir,
        env: {
          OPENCODE_CONFIG: opencodeJsonPath,
          OPENCODE_GIT_GUARD_AUDIT: auditPath,
          ...scenario.env,
        },
      },
    )

    const audit = readAudit(auditPath)
    const problem = scenario.assert(audit, runResult.out)
    const headAfter = git(["rev-parse", "HEAD"]).out.trim()

    // I1/I4/I5 must not create commits; I6/I7 must not modify protected files.
    if (
      ["I1-deny-no-verify", "I4-codemode-blocked", "I5-deny-config-override"].includes(scenario.id) &&
      headBefore !== headAfter
    ) {
      results.push({ id: scenario.id, status: "FAIL", detail: `${problem ?? ""} [HEAD advanced — a commit slipped through]`.trim() })
      continue
    }
    if (problem) {
      console.log(`--- ${scenario.id} run output (tail) ---`)
      console.log(runResult.out.split(/\r?\n/).slice(-14).join("\n"))
    }
    results.push(problem ? { id: scenario.id, status: "FAIL", detail: problem } : { id: scenario.id, status: "PASS" })
  }

  console.log(`\nIntegration results (base HEAD ${baseHead.slice(0, 8)}):`)
  for (const r of results) console.log(`  ${r.status === "PASS" ? "✔" : "✘"} ${r.id}${r.detail ? ` — ${r.detail}` : ""}`)
  const failed = results.filter((r) => r.status === "FAIL")
  console.log(failed.length === 0 ? "\nALL INTEGRATION SCENARIOS PASS" : `\n${failed.length} SCENARIO(S) FAILED`)
  if (failed.length > 0) process.exit(1)
}

run()
