// Smoke test: verify the npm-plugin install
// path — package a tarball, reference it as an npm plugin, and assert the
// plugin loads from OpenCode's plugin cache and reports its own path there.
//
// Usage: bun test/integration/npm-smoke.ts

import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = join(here, "..", "..")
const projectDir = join(here, `npm-smoke-project-${Date.now() % 100000}`)
const cacheRoot = join(homedir(), ".cache", "opencode")

function sh(cmd: string, args: string[], opts: { cwd: string; env?: Record<string, string> }) {
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, encoding: "utf8", timeout: 300_000 })
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }
}

const tgz = join(packageDir, "opencode-git-integrity-smoke.tgz")

// 1. pack (deterministic name; ignore npm's default naming)
rmSync(tgz, { force: true })
const pack = sh("npm", ["pack", "--pack-destination", packageDir], { cwd: packageDir })
const packed = /\S*opencode-git-integrity\S*\.tgz/.exec(pack.out)?.[0]
if (!packed) {
  console.error("FAIL: npm pack produced no tarball\n" + pack.out.slice(0, 500))
  process.exit(1)
}
rmSync(tgz, { force: true })
const tarball = join(packageDir, packed)

// 2. scratch project referencing the tarball as an npm plugin (forward slashes — JSON)
rmSync(projectDir, { recursive: true, force: true })
mkdirSync(projectDir, { recursive: true })
const opencodeJson = join(projectDir, "opencode.json")
const tarballUrl = `file:${tarball.replace(/\\/g, "/")}`
writeFileSync(opencodeJson, JSON.stringify({ plugins: [{ package: tarballUrl }] }, null, 2))

// 3. run with audit; the plugin's startup line reports its resolved directory
const auditPath = join(projectDir, "audit.jsonl")
rmSync(auditPath, { force: true })
const run = sh("opencode", ["run", "--standalone", "--session", `ses-m2-npm-smoke-${Date.now() % 100000}`, "Reply with exactly: OK"], {
  cwd: projectDir,
  env: { OPENCODE_CONFIG: opencodeJson, OPENCODE_GIT_GUARD_AUDIT: auditPath },
})

rmSync(tarball, { force: true })

const lines = existsSync(auditPath)
  ? readFileSync(auditPath, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l))
  : []
const startup = lines.find((l) => l.kind === "startup")

const failures: string[] = []
if (!startup) {
  failures.push(
    `plugin never started from the npm install; config=${readFileSync(opencodeJson, "utf8")}; tarball exists=${existsSync(tarball)}; run tail:\n${run.out.split(/\r?\n/).slice(-8).join("\n")}`,
  )
} else {
  // location.directory is the SESSION PROJECT dir by design; the plugin's own
  // install path is import.meta.url — assert the npm layout there.
  const self = String(startup.self ?? "")
  const selfNorm = self.replace(/\\/g, "/").toLowerCase()
  const cacheNorm = cacheRoot.replace(/\\/g, "/").toLowerCase()
  if (!selfNorm.includes("opencode-git-integrity")) failures.push(`self path does not contain the package name: ${self}`)
  if (!selfNorm.startsWith("file:///") ) failures.push(`self path is not a file URL: ${self}`)
  console.log(`plugin self path: ${self}`)
  if (selfNorm.includes(cacheNorm)) {
    console.log(`npm-cache layout confirmed: under ${cacheRoot}`)
  } else {
    console.log(`note: self path not under ${cacheRoot} — record actual layout in results`)
    failures.push(`self path not under the opencode plugin cache (${cacheRoot}): ${self}`)
  }
}

console.log(failures.length === 0 ? "\nNPM-CACHE SMOKE PASS" : `\nNPM-CACHE SMOKE FAIL:\n  ${failures.join("\n  ")}`)
if (failures.length > 0) process.exit(1)
