// Fuzz-equivalence harness (plan §9): generate permutations of bypass attacks
// (flag order × global-opt order × value quoting × wrapper nesting × separators)
// and assert decision EQUIVALENCE — the property the spec cares about. A
// deterministic seeded PRNG keeps the suite reproducible in CI.
//
// Generator constraints (each mirrors real-shell semantics — the harness must
// only produce commands that MEAN the same thing as the base attack):
//   - value-taking flags stay glued to their values when shuffling
//   - nested same-quote wrapping is never generated
//   - env-prefix wrappers apply only at the outermost level (routers exec
//     argv, they are not shells)

import { describe, expect, test } from "bun:test"
import { classifyResources } from "../src/classify/shell.js"
import { createFixtureState } from "../src/state.js"
import { createFixtureRepo } from "../src/repo.js"
import { defaultConfig } from "../src/config.js"

const deps = {
  cfg: defaultConfig(),
  st: createFixtureState([{ tag: "global", entries: { "commit.gpgsign": "true" } }], { root: "G:/repo", gitDir: "G:/repo/.git" }),
  repo: createFixtureRepo({ root: "G:/repo", gitDir: "G:/repo/.git" }),
  managers: new Set<string>(),
  aliases: {},
  snapshot: undefined,
  expectedDrift: false,
}

// deterministic LCG
let seed = 0x2f6e2b1
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]
const maybe = (p: number) => rand() < p

type Variant = { argv: string[]; expect: "deny" | "allow"; note: string }

const DENY_VARIANTS: Variant[] = [
  { argv: ["commit", "--no-verify", "-m", "msg"], expect: "deny", note: "commit --no-verify" },
  { argv: ["commit", "-n", "-m", "msg"], expect: "deny", note: "commit -n" },
  { argv: ["push", "--no-verify", "origin", "main"], expect: "deny", note: "push --no-verify" },
  { argv: ["merge", "--no-verify", "main"], expect: "deny", note: "merge --no-verify" },
  { argv: ["-c", "core.hooksPath=/dev/null", "commit", "-m", "msg"], expect: "deny", note: "-c null hooksPath" },
  { argv: ["-c", "commit.gpgsign=false", "commit", "-m", "msg"], expect: "deny", note: "-c signing off" },
  { argv: ["commit", "--no-gpg-sign", "-m", "msg"], expect: "deny", note: "commit --no-gpg-sign" },
]

const ALLOW_VARIANTS: Variant[] = [
  { argv: ["push", "-n", "origin", "HEAD"], expect: "allow", note: "push dry-run" },
  { argv: ["commit", "-c", "HEAD", "-m", "msg"], expect: "allow", note: "commit -c HEAD" },
  { argv: ["-c", "core.pager=cat", "log", "--oneline"], expect: "allow", note: "-c unprotected key" },
  { argv: ["status"], expect: "allow", note: "status" },
]

/** Tokens grouped so a value-taking flag stays with its value (`-m msg`). */
function groupTokens(argv: string[]): string[][] {
  const VALUE_FLAGS = new Set(["-m", "-c", "-C", "-F", "--file", "--message"])
  const groups: string[][] = []
  for (let i = 0; i < argv.length; i++) {
    if (VALUE_FLAGS.has(argv[i]) && i + 1 < argv.length) {
      groups.push([argv[i], argv[i + 1]])
      i++
    } else {
      groups.push([argv[i]])
    }
  }
  return groups
}

/** Shuffle argument groups ONLY after the subcommand (position-sensitive
 * global options like `-c k=v` must stay before it). */
function shuffleTail(argv: string[]): string[] {
  const groups = groupTokens(argv)
  let sub = argv.findIndex((w) => !w.startsWith("-"))
  while (sub > 0 && argv[sub].includes("=") && argv[sub - 1] === "-c") {
    sub = argv.findIndex((w, i) => i > sub && !w.startsWith("-"))
  }
  const fixed = groups.slice(0, sub + 1)
  const tail = groups.slice(sub + 1)
  for (let i = tail.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[tail[i], tail[j]] = [tail[j], tail[i]]
  }
  return [...fixed, ...tail].flat()
}

/** Quote the message value when the whole command stays unquoted at top level. */
function quoteMessages(cmd: string, allowQuotes: boolean): string {
  if (!allowQuotes || maybe(0.4)) return cmd
  return maybe(0.5) ? cmd.replace(/ msg\b/g, ' "msg text"') : cmd.replace(/ msg\b/g, " 'msg text'")
}

type WrapStyle = "bash-dq" | "cmd-dq" | "rtk" | "prefix-cmd"

function wrapOnce(cmd: string, style: WrapStyle): string {
  switch (style) {
    case "bash-dq":
      return `bash -c "${cmd.replace(/"/g, '\\"')}"`
    case "cmd-dq":
      return `cmd /c "${cmd}"`
    case "rtk":
      return `rtk ${cmd}`
    case "prefix-cmd":
      return `echo ok; ${cmd} || true`
  }
}

function buildCommand(variant: Variant): string {
  const argv = shuffleTail([...variant.argv])
  const noise = maybe(0.6) ? ["-c", "color.ui=auto"] : []
  const gitCmd = ["git", ...noise, ...argv].join(" ")

  // quote-consuming wraps (bash -c "…", cmd /c "…") are only applied to a
  // payload that contains no double quotes — chaining them would produce
  // quote-substituted nonsense a real shell could not execute either.
  const wrapCount = Math.floor(rand() * 3)
  let cmd = quoteMessages(gitCmd, wrapCount === 0)
  for (let i = 0; i < wrapCount; i++) {
    const quoteFree = !cmd.includes('"')
    const options: WrapStyle[] = quoteFree
      ? (["bash-dq", "cmd-dq", "rtk", "prefix-cmd"] as WrapStyle[])
      : ["rtk", "prefix-cmd"]
    cmd = wrapOnce(cmd, pick(options))
  }
  if (maybe(0.4)) cmd = `echo start && ${cmd}`
  if (maybe(0.3)) cmd = `BENIGN_ENV=1 ${cmd}`
  return cmd
}

describe("fuzz: decision equivalence across permutations", () => {
  test("bypass attacks deny under every generated permutation", () => {
    const failures: string[] = []
    for (let i = 0; i < 300; i++) {
      const variant = pick(DENY_VARIANTS)
      const cmd = buildCommand(variant)
      const result = classifyResources([cmd], deps)
      if (result.decision !== "deny") failures.push(`[${variant.note}] expected deny, got ${result.decision}: ${cmd}`)
    }
    expect(failures.join("\n")).toBe("")
  })

  test("FP anchors allow under every generated permutation", () => {
    const failures: string[] = []
    for (let i = 0; i < 300; i++) {
      const variant = pick(ALLOW_VARIANTS)
      const cmd = buildCommand(variant)
      const result = classifyResources([cmd], deps)
      if (result.decision !== "allow") failures.push(`[${variant.note}] expected allow, got ${result.decision}: ${cmd}`)
    }
    expect(failures.join("\n")).toBe("")
  })

  test("all forms of one attack class produce the same decision (equivalence closure)", () => {
    for (const variant of DENY_VARIANTS) {
      const decisions = new Set<string>()
      for (let i = 0; i < 40; i++) decisions.add(classifyResources([buildCommand(variant)], deps).decision)
      expect([...decisions].join("|")).toBe("deny")
    }
  })
})
