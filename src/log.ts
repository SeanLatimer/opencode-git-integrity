// Structured audit log. Appends JSONL to $OPENCODE_GIT_GUARD_AUDIT when set
// (used by the integration harness); internal errors additionally go to
// stderr so they surface under `opencode run --print-logs`.

import { appendFileSync } from "node:fs"

export function audit(kind: string, entry: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), kind, ...entry })
  const file = process.env.OPENCODE_GIT_GUARD_AUDIT
  if (file) {
    try {
      appendFileSync(file, line + "\n")
    } catch {
      // auditing must never break the guard
    }
  }
  if (kind === "internal-error") console.error("[git-integrity]", line)
}
