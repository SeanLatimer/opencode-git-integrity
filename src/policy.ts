// Policy resolution: a finding's final level comes from the configured policy
// (defaulting to the evaluator's level). Users may raise or lower levels; the
// deliberate ask-level downgrades in invariants.ts (real-dir hooksPath,
// unresolved values) are honored unless the user configured stricter.

import { Finding, Level } from "./types.js"
import { GuardConfig } from "./config.js"

export function applyPolicy(findings: Finding[], cfg: GuardConfig): Finding[] {
  return findings.map((f) => ({
    ...f,
    level: (cfg.policy[f.invariantId] ?? f.level) as Finding["level"],
  }))
}

export function maxSeverity(a: Level, b: Level): Level {
  const rank: Record<Level, number> = { allow: 0, ask: 1, deny: 2 }
  return rank[a] >= rank[b] ? a : b
}
