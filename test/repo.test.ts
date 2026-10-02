// Real-filesystem gitdir discovery tests: linked worktrees + submodules.
// Uses the approved temp dir; creates a real main repo, a linked worktree, and
// a submodule — then asserts discoverRepo/classifyProtectedPath against them.

import { describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { discoverRepo, classifyProtectedPath, isInsideGitDir, createFixtureRepo } from "../src/repo.js"

const base = join(tmpdir(), "opencode-git-integrity-m2")

/** File identity (dev/inode) — immune to 8.3 short names, case, separators. */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a)
    const sb = statSync(b)
    return sa.ino === sb.ino && sa.dev === sb.dev
  } catch {
    return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase()
  }
}

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`)
  return r.stdout
}

function setup(): { main: string; worktree: string } {
  rmSync(base, { recursive: true, force: true })
  const main = join(base, "main")
  const worktree = join(base, "wt")
  const sub = join(base, "sub")
  mkdirSync(main, { recursive: true })
  mkdirSync(sub, { recursive: true })
  for (const repo of [main, sub]) {
    sh("git", ["init", "-b", "main"], repo)
    sh("git", ["config", "user.email", "m2@test.local"], repo)
    sh("git", ["config", "user.name", "Discovery"], repo)
    sh("git", ["config", "commit.gpgsign", "false"], repo)
  }
  writeFileSync(join(main, "a.txt"), "a\n")
  sh("git", ["add", "a.txt"], main)
  sh("git", ["commit", "-m", "init"], main)
  writeFileSync(join(sub, "s.txt"), "s\n")
  sh("git", ["add", "s.txt"], sub)
  sh("git", ["commit", "-m", "init"], sub)
  // linked worktree
  sh("git", ["worktree", "add", "-b", "wt", worktree], main)
  // submodule (local path needs protocol.file.allow on modern git)
  sh("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-b", "main", sub, "vendor/sub"], main)
  sh("git", ["commit", "-m", "add submodule"], main)
  return { main, worktree }
}

describe("gitdir discovery (real worktree + submodule)", () => {
  const { main, worktree } = setup()

  test("main repo resolves", () => {
    const repo = discoverRepo(main)!
    expect(sameFile(repo.gitDir, join(main, ".git"))).toBe(true)
    expect(sameFile(repo.commonDir, join(main, ".git"))).toBe(true)
    expect(repo.worktreeGitDirs.some((g) => sameFile(g, join(main, ".git", "worktrees", "wt")))).toBe(true)
    expect(repo.moduleGitDirs.some((g) => sameFile(g, join(main, ".git", "modules", "vendor", "sub")))).toBe(true)
  })

  test("linked worktree resolves pointer + commondir", () => {
    const repo = discoverRepo(worktree)!
    expect(repo.root).toBe(worktree)
    expect(sameFile(repo.gitDir, join(main, ".git", "worktrees", "wt"))).toBe(true)
    expect(sameFile(repo.commonDir, join(main, ".git"))).toBe(true)
  })

  test("protected paths across worktree/submodule gitdirs", () => {
    const fromWorktree = discoverRepo(worktree)!
    expect(classifyProtectedPath(join(main, ".git", "config"), fromWorktree)).toBe("metadata")
    expect(classifyProtectedPath(join(main, ".git", "worktrees", "wt", "config.worktree"), fromWorktree)).toBe("metadata")
    expect(classifyProtectedPath(join(main, ".git", "modules", "vendor", "sub", "config"), fromWorktree)).toBe("metadata")
    expect(classifyProtectedPath(join(main, ".git", "modules", "vendor", "sub", "hooks", "pre-commit"), fromWorktree)).toBe("hooks")
    expect(classifyProtectedPath(join(main, ".git", "modules", "vendor", "sub", "hooks", "pre-commit.sample"), fromWorktree)).toBe("sample")
    expect(classifyProtectedPath(join(main, ".git", "hooks", "pre-commit"), fromWorktree)).toBe("hooks")
    expect(classifyProtectedPath(join(worktree, ".git"), fromWorktree)).toBe("metadata") // pointer file
    expect(classifyProtectedPath(join(main, ".git", "index"), fromWorktree)).toBeNull() // write-precise: not a root
    expect(isInsideGitDir(join(main, ".git", "index"), fromWorktree)).toBe(true) // destructive-broad
    expect(classifyProtectedPath(join(worktree, "src", "index.ts"), fromWorktree)).toBeNull()
  })

  test("submodule checkout's .git pointer inside the worktree is metadata", () => {
    const repo = discoverRepo(main)!
    // .gitmodules file itself is NOT protected (versioned content)
    expect(classifyProtectedPath(join(main, ".gitmodules"), repo)).toBeNull()
    // submodule checkout dir pointer: <main>/vendor/sub/.git is a FILE
    expect(classifyProtectedPath(join(main, "vendor", "sub", ".git"), repo)).toBe("metadata")
  })

  test("user protectPaths patterns match relative paths", () => {
    const repo = createFixtureRepo({ root: "G:/repo", gitDir: "G:/repo/.git" })
    expect(classifyProtectedPath("G:/repo/.git/info/exclude", repo, [".git/**"])).toBe("user")
    expect(classifyProtectedPath("G:/repo/src/x.ts", repo, [".git/**"])).toBeNull()
  })

  test("nested worktree subdir resolves by walk-up", () => {
    const repo = discoverRepo(worktree)!
    expect(sameFile(repo.root, worktree)).toBe(true)
  })
})
