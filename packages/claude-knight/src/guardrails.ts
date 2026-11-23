/**
 * Bash guardrails shared by both runtimes: the in-process SDK hook (hooks.ts)
 * and the command hook the CLI runtime calls (`node dist/index.js hook
 * pretooluse`, hook-cli.ts). No SDK or metrics imports, so the hook process
 * starts fast.
 */
export const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$|\*)/, reason: "Recursive delete at root level" },
  // Match the flag as a whole token: not a branch like `fix-f`, and --force-with-lease stays allowed.
  { pattern: /\bgit\s+push\b[^;&|\n]*\s--force(?=\s|$)/, reason: "Force push without lease (use --force-with-lease or new commits)" },
  { pattern: /\bgit\s+push\b[^;&|\n]*\s-[a-zA-Z]*f[a-zA-Z]*(?=\s|$)/, reason: "Force push (use new commits instead)" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "World-writable permissions" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Direct device write" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "Filesystem format" },
];

/** Prefix of every denial reason; the CLI runtime counts blocked calls by it. */
export const BLOCK_REASON_PREFIX = "Blocked by knight safety policy: ";

export function checkBashCommand(command: string): string | undefined {
  for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

/** The PreToolUse input fields the guardrail reads (SDK HookInput and CLI hook stdin share them). */
export interface PreToolUseInput {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
}

export interface PreToolUseDeny {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "deny";
    permissionDecisionReason: string;
  };
}

/**
 * Decide a PreToolUse event: a deny output for a blocked Bash command, else
 * undefined (no opinion, Claude Code carries on). The output shape is the same
 * for SDK callback hooks and CLI command hooks (JSON on stdout, exit 0).
 */
export function decidePreToolUse(input: PreToolUseInput): { reason: string; command: string; output: PreToolUseDeny } | undefined {
  if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") return undefined;
  const command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? "");
  const reason = checkBashCommand(command);
  if (!reason) return undefined;
  return {
    reason,
    command,
    output: {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `${BLOCK_REASON_PREFIX}${reason}`,
      },
    },
  };
}
