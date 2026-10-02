// Denial messages. Evidence always names the exact parsed
// token/flag/key — proof of semantic (not substring) detection. Thrown as the
// tool error / permission message → the model sees it verbatim.

import { Finding } from "./types.js"
import { GuardConfig } from "./config.js"

const EXPLANATIONS: Record<string, string> = {
  "commit.hooks.must-run": "This command bypasses the repository hooks that guard commit creation (pre-commit/commit-msg).",
  "push.hooks.must-run": "This command bypasses the pre-push hook.",
  "commit.signing.must-stay-enabled": "This command disables commit signing that is currently enabled for this repository.",
  "tag.signing.must-stay-enabled": "This command disables tag signing that is currently configured for this repository.",
  "push.signing.must-stay-enabled": "This command disables push signing that is currently configured for this repository.",
  "hooks.config.frozen": "This command weakens hook configuration (core.hooksPath / hook.*.enabled).",
  "signing.config.frozen": "This command hides the configuration source that currently provides signing/hook settings.",
  "hookmanagers.must-run": "This command disables or removes the repository's hook manager for this invocation.",
  "plumbing.suspicious": "This command creates commits/refs through git plumbing, which does not run repository hooks.",
  "alias.unresolved": "This git subcommand is not recognized and may be a locally-defined alias whose expansion cannot be verified.",
  "guard.self-protected": "This command modifies the guard itself.",
  "git.scope.shift": "This command targets a git directory outside the session's repository.",
  "x-dynamic-argument": "This command passes a dynamically computed argument to a protected git subcommand, so it cannot be verified.",
  "parse.failed": "This command invokes git in a form the guard cannot parse; unparseable git commands are blocked by policy (failMode=closed).",
}

export function render(finding: Finding, cfg: GuardConfig): string {
  return [
    cfg.message.header,
    "",
    `Policy: ${finding.invariantId}`,
    `Evidence: ${finding.evidence}`,
    EXPLANATIONS[finding.invariantId] ?? "This action would weaken Git integrity controls.",
    finding.fixHint,
    "",
    "If this is genuinely intended, ask the user to run it in their terminal",
    "or arm a temporary permit (see git-guard docs).",
  ].join("\n")
}
