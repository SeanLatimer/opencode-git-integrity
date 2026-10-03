// @seanlatimer/opencode-git-integrity — plugin entry (opencode v2.0.22 promise API).
//
// Enforcement model :
//   1. ctx.permission.hook("evaluate") — PRIMARY decision surface for the shell
//      tool. Fires on the allow and ask paths with per-command resources; we
//      set native allow/ask/deny + message. This handler must NEVER throw
//      (core PluginHooks contract).
//   2. ctx.tool.hook("execute.before") — captures shell scripts for evaluation;
//      Code Mode (`execute` tool),
//      which bypasses the permission pipeline entirely (verified live).
//      Throw-to-block; ask-level findings are demoted to deny here (Code Mode
//      cannot host an interactive ask) — documented limitation.

import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { classifyResources } from "./classify/shell.js"
import { classifyCodeMode } from "./classify/codemode.js"
import { classifyEditResource } from "./classify/files.js"
import { detectManagers } from "./classify/managers.js"
import { takeSnapshot } from "./classify/invariants.js"
import { createRealState } from "./state.js"
import { discoverRepo, createFixtureRepo } from "./repo.js"
import { loadConfig } from "./config.js"
import { render } from "./messages.js"
import { audit } from "./log.js"
import { permitCovers, armPendingPermit, parseTokens } from "./permits.js"
import type { Finding } from "./types.js"

type PluginContext = {
  options?: unknown
  location?: { directory?: string; project?: { directory?: string } }
  permission?: { hook: (name: "evaluate", cb: (event: any) => void) => Promise<{ dispose: () => Promise<void> }> }
  tool?: { hook: (name: "execute.before" | "execute.after", cb: (event: any) => void) => Promise<{ dispose: () => Promise<void> }> }
  command?: { transform: (cb: (editor: any) => void) => Promise<{ dispose: () => Promise<void> }> }
}

export default {
  id: "@seanlatimer/opencode-git-integrity",
  setup: async (ctx: PluginContext) => {
    const directory = ctx?.location?.directory ?? ctx?.location?.project?.directory ?? process.cwd()
    const { config, warnings } = loadConfig(ctx?.options, directory)
    for (const w of warnings) audit("config-warning", { warning: w })

    if (!config.enabled) {
      audit("startup", { enabled: false, note: "guard disabled by configuration" })
      return () => {}
    }

    const state = createRealState(directory)
    const repo = discoverRepo(directory) ?? createFixtureRepo({ root: directory, gitDir: join(directory, ".git") })
    // guard self-protection paths (§5.4): own install dir + config files
    const guardPaths = [
      join(dirname(fileURLToPath(import.meta.url)), ".."),
      join(homedir(), ".config", "opencode", "git-guard.json"),
      join(directory, ".opencode", "git-guard.json"),
    ]
    const deps = {
      cfg: config,
      st: state,
      repo,
      managers: detectManagers(repo.root, state),
      aliases: state.aliases(),
      snapshot: takeSnapshot(state),
      expectedDrift: false,
      guardPaths,
    }
    audit("startup", {
      self: import.meta.url,
      directory,
      cwd: process.cwd(),
      root: repo.root,
      gitDir: repo.gitDir,
      commonDir: repo.commonDir,
      worktrees: repo.worktreeGitDirs.length,
      modules: repo.moduleGitDirs.length,
      managers: [...deps.managers],
      failMode: config.failMode,
    })

    const registrations: Array<{ dispose: () => Promise<void> }> = []
    // Shell permission resources omit expression statements such as $env:X=….
    // Preserve the complete script, scoped to the exact call (not the session),
    // and still make all shell decisions in permission.evaluate.
    const shellScripts = new Map<string, string>()
    const callKey = (sessionID: unknown, messageID: unknown, id: unknown) =>
      typeof sessionID === "string" && typeof messageID === "string" && typeof id === "string"
        ? JSON.stringify([sessionID, messageID, id])
        : undefined

    if (typeof ctx?.permission?.hook === "function") {
      registrations.push(
        await ctx.permission.hook("evaluate", (event) => {
          try {
            if (event.action === "shell") {
              const key = event.source?.type === "tool"
                ? callKey(event.sessionID, event.source.messageID, event.source.id)
                : undefined
              const script = key === undefined ? undefined : shellScripts.get(key)
              const result = classifyResources([
                ...(script === undefined ? [] : [script]),
                ...(event.resources ?? []),
              ], deps)
              audit("decision", {
                action: event.action,
                resources: event.resources,
                decision: result.decision,
                invariant: result.finding?.invariantId,
                fullScript: script !== undefined,
              })
              if (result.finding && permitCovers(result.finding.invariantId, event.sessionID).covered) {
                audit("permit-applied", { invariant: result.finding.invariantId, via: "shell" })
                return
              }
              if (result.decision === "deny" && result.finding) {
                event.effect = "deny"
                event.message = render(result.finding, config)
              } else if (result.decision === "ask" && result.finding && event.effect === "allow") {
                event.effect = "ask"
                event.message = render(result.finding, config)
              }
              return
            }
            if (event.action === "edit" || event.action === "write" || event.action === "patch") {
              // resources are worktree-relative, forward-slashed paths (verified empirically)
              for (const resource of event.resources ?? []) {
                const finding = classifyEditResource(String(resource), deps.repo, config, deps.guardPaths)
                if (!finding) continue
                audit("decision", { action: event.action, resources: [resource], decision: finding.level, invariant: finding.invariantId })
                if (permitCovers(finding.invariantId, event.sessionID).covered) {
                  audit("permit-applied", { invariant: finding.invariantId, via: "edit" })
                  return
                }
                if (finding.level === "deny") {
                  event.effect = "deny"
                  event.message = render(finding, config)
                } else if (event.effect === "allow") {
                  event.effect = "ask"
                  event.message = render(finding, config)
                }
                return
              }
            }
          } catch (error) {
            audit("internal-error", { hook: "permission.evaluate", error: String(error) })
            // never throw from the evaluate hook
          }
        }),
)
    } else {
      audit("capability-missing", { domain: "permission.hook", note: "evaluate enforcement unavailable at this opencode version" })
    }

    if (typeof ctx?.tool?.hook === "function") {
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => {
          let guardError: Error | undefined
          try {
            if (event.tool === "shell") {
              const key = callKey(event.sessionID, event.messageID, event.id)
              const command = event.input?.command
              if (key !== undefined && typeof command === "string") shellScripts.set(key, command)
              return
            }
            if (event.tool !== "execute") return
            const code = typeof (event.input as { code?: unknown } | undefined)?.code === "string"
              ? (event.input as { code: string }).code
              : ""
            const result = classifyCodeMode(code, deps)
            audit("codemode-decision", {
              decision: result.decision,
              invariant: result.finding?.invariantId,
            })
            if (result.decision !== "allow" && result.finding) {
              const demoted: Finding = { ...result.finding, level: "deny" }
              guardError = new Error(render(demoted, config))
            }
          } catch (error) {
            audit("internal-error", { hook: "tool.execute.before", error: String(error) })
          }
          if (guardError) {
            // permits apply to Code Mode findings too (ask demoted silently)
            const m = /Policy: (\S+)/.exec(guardError.message)
            if (m && permitCovers(m[1], (event as { sessionID?: string }).sessionID).covered) {
              audit("permit-applied", { invariant: m[1], via: "codemode" })
              return
            }
            throw guardError
          }
        }),
)
      registrations.push(
        await ctx.tool.hook("execute.after", (event) => {
          const key = callKey(event.sessionID, event.messageID, event.id)
          if (key !== undefined) shellScripts.delete(key)
        }),
      )
    } else {
      audit("capability-missing", { domain: "tool.hook", note: "Code Mode enforcement unavailable at this opencode version" })
    }

    // /git-guard-permit — user-issued one-shot permit (agents cannot invoke
    // slash commands;). Consumed by the next matching finding.
    if (typeof ctx?.command?.transform === "function") {
      await ctx.command.transform((editor) => {
        editor.add({
          name: "git-guard-permit",
          description: "Arm a one-shot git-guard permit (domains: hooks, signing, config, files, managers, plumbing, scope, all)",
          execute: async (input) => {
            const text =
              (input.prompt as unknown as { text?: string })?.text ??
              String((input.prompt as unknown as { data?: unknown })?.data ?? "")
            const tokens = parseTokens(String(text))
            armPendingPermit(String(input.sessionID), tokens)
            audit("permit-armed", { sessionID: String(input.sessionID), tokens, ttlMinutes: 10 })
          },
        })
      })
    }

    return async () => {
      shellScripts.clear()
      for (const r of registrations) await r.dispose()
    }
  },
}
