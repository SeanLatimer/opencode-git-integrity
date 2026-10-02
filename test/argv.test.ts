import { describe, expect, test } from "bun:test"
import { lex } from "../src/parse/lexer.js"
import { buildCommands } from "../src/parse/commands.js"
import { unwrapAll } from "../src/parse/unwrap.js"
import { parseGitInvocation } from "../src/git/argv.js"

function gitOf(command: string) {
  const cmds = buildCommands(lex(command))
  return parseGitInvocation(cmds[0], command)
}

describe("git argv model (position sensitivity)", () => {
  test("global -c before subcommand is config", () => {
    const gi = gitOf("git -c core.hooksPath=/dev/null commit -m x")!
    expect(gi.subcommand).toBe("commit")
    expect(gi.globalOpts.config).toEqual([{ key: "core.hookspath", value: "/dev/null", channel: "dashC" }])
    expect(gi.flags).not.toContain("-c")
  })

  test("subcommand -c reuses a message, is not config", () => {
    const gi = gitOf("git commit -c HEAD -m x")!
    expect(gi.globalOpts.config.length).toBe(0)
    expect(gi.flags).toContain("-c")
  })

  test("attached -c form", () => {
    const gi = gitOf("git -ccore.hooksPath=/dev/null commit")!
    expect(gi.globalOpts.config[0].key).toBe("core.hookspath")
  })

  test("bare -c key means boolean true", () => {
    const gi = gitOf("git -c commit.gpgsign commit -m x")!
    expect(gi.globalOpts.config[0]).toEqual({ key: "commit.gpgsign", value: true, channel: "dashC" })
  })

  test("bundled shorts expand on commit", () => {
    const gi = gitOf("git commit -qn -m wip")!
    expect(gi.flags).toContain("-q")
    expect(gi.flags).toContain("-n")
  })

  test("-m consumes the next token as data", () => {
    const gi = gitOf('git commit -m "--no-verify"')!
    expect(gi.flags).toContain("-m")
    expect(gi.flags).not.toContain("--no-verify")
    expect(gi.args.length).toBe(0)
  })

  test("-- separator makes the rest positional", () => {
    const gi = gitOf("git commit -- --no-verify")!
    expect(gi.flags).not.toContain("--no-verify")
    expect(gi.args.map((a) => a.value)).toEqual(["--no-verify"])
  })

  test("--signed=false keeps its value form", () => {
    const gi = gitOf("git push --signed=false origin")!
    expect(gi.flags).toContain("--signed=false")
  })

  test("--config-env attached and spaced forms", () => {
    expect(gitOf("git --config-env=core.hooksPath=EMPTY commit")!.globalOpts.configEnv[0]).toMatchObject({
      key: "core.hookspath",
      envName: "EMPTY",
    })
    expect(gitOf("git --config-env core.hooksPath=EMPTY commit")!.globalOpts.configEnv[0]).toMatchObject({
      key: "core.hookspath",
      envName: "EMPTY",
    })
  })

  test("quoted absolute git.exe normalizes", () => {
    const gi = gitOf('"C:\\Program Files\\Git\\cmd\\git.exe" commit --no-verify')!
    expect(gi.exe).toBe("git")
    expect(gi.subcommand).toBe("commit")
  })

  test("gitDir global opt captured", () => {
    const gi = gitOf("git --git-dir=/tmp/fake/.git commit")!
    expect(gi.globalOpts.gitDir).toBe("/tmp/fake/.git")
  })

  test("non-git programs are not git invocations", () => {
    const cmds = buildCommands(lex("grep -- --no-verify file"))
    expect(parseGitInvocation(cmds[0], "grep")).toBeNull()
  })

  test("wrapper unwrapping accumulates env", () => {
    const cmds = buildCommands(lex("GIT_A=1 env GIT_B=2 git -c x=y commit"))
    const env0: Record<string, string> = {}
    for (const a of cmds[0].assignments) env0[a.name] = a.value
    const leaves = unwrapAll(cmds[0], env0, [])
    expect(leaves.length).toBe(1)
    expect(leaves[0].env).toEqual({ GIT_A: "1", GIT_B: "2" })
    const gi = parseGitInvocation(leaves[0].cmd, "env git")!
    expect(gi.subcommand).toBe("commit")
    expect(gi.globalOpts.config[0].key).toBe("x")
  })

  test("bash -c nested script becomes commands", () => {
    const cmds = buildCommands(lex('bash -c "git commit --no-verify && echo done"'))
    const leaves = unwrapAll(cmds[0], {}, [])
    expect(leaves.map((l) => l.cmd.words[0].value)).toEqual(["git", "echo"])
  })

  test("depth cap throws beyond 5", () => {
    let cmd = "git commit --no-verify"
    for (let i = 0; i < 8; i++) cmd = `bash -c "${cmd.replace(/"/g, '\\"')}"`
    const cmds = buildCommands(lex(cmd))
    expect(() => unwrapAll(cmds[0], {}, [])).toThrow()
  })

  test("push -n stays a flag but in the dry-run namespace", () => {
    const gi = gitOf("git push -n origin HEAD")!
    expect(gi.flags).toContain("-n")
    expect(gi.subcommand).toBe("push")
  })

  test("merge -n is no-stat", () => {
    const gi = gitOf("git merge -n origin/main")!
    expect(gi.subcommand).toBe("merge")
    expect(gi.flags).toContain("-n")
  })

  test("tag -n5 attaches its value", () => {
    const gi = gitOf("git tag -n5")!
    expect(gi.subcommand).toBe("tag")
  })
})
