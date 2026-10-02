// Permits: the human escape hatch. Two channels:
//   1. $OPENCODE_GIT_GUARD_PERMIT (OpenCode's process env — the agent can only
//      set env for its commands, never the server process, so it cannot
//      self-grant): comma list of domains or exact invariant IDs.
//   2. `/git-guard-permit <tokens>` — a user-issued command (agents cannot
//      invoke slash commands); one-shot: consumed by the next matching finding,
//      expiring after 10 minutes.
// Domains: hooks, signing, config, files, managers, plumbing, scope, dynamic, parse, all.

export const PERMIT_DOMAINS: Record<string, Array<string>> = {
  hooks: ["commit.hooks.must-run", "push.hooks.must-run", "hooks.config.frozen", "hooks.files.protected"],
  signing: ["commit.signing.must-stay-enabled", "tag.signing.must-stay-enabled", "push.signing.must-stay-enabled", "signing.config.frozen"],
  config: ["hooks.config.frozen", "signing.config.frozen"],
  files: ["hooks.files.protected", "git.metadata.protected"],
  managers: ["hookmanagers.must-run"],
  plumbing: ["plumbing.suspicious"],
  scope: ["git.scope.shift"],
  dynamic: ["x-dynamic-argument"],
  parse: ["parse.failed"],
}

export type PendingPermit = { tokens: string[]; expires: number }

const pending = new Map<string, PendingPermit>()
const PENDING_TTL_MS = 10 * 60 * 1000

export function parseTokens(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
}

export function envPermitTokens(): string[] {
  const raw = process.env.OPENCODE_GIT_GUARD_PERMIT
  return raw ? parseTokens(raw) : []
}

export function armPendingPermit(sessionID: string, tokens: string[]) {
  if (tokens.length === 0) return
  pending.set(sessionID, { tokens, expires: Date.now() + PENDING_TTL_MS })
}

function coveredBy(invariantId: string, tokens: string[]): boolean {
  for (const token of tokens) {
    if (token === "all") return true
    if (token === invariantId.toLowerCase()) return true
    const domain = PERMIT_DOMAINS[token]
    if (domain?.includes(invariantId)) return true
  }
  return false
}

/**
 * True (and consumed, when from the pending channel) when a permit covers the
 * invariant. Pending permits are one-shot per matching finding.
 */
export function permitCovers(invariantId: string, sessionID?: string): { covered: boolean; consumed: boolean } {
  if (coveredBy(invariantId, envPermitTokens())) return { covered: true, consumed: false }
  if (sessionID) {
    const p = pending.get(sessionID)
    if (p && Date.now() < p.expires && coveredBy(invariantId, p.tokens)) {
      pending.delete(sessionID)
      return { covered: true, consumed: true }
    }
    if (p && Date.now() >= p.expires) pending.delete(sessionID)
  }
  return { covered: false, consumed: false }
}
