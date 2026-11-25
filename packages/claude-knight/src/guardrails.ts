import { BLOCK_REASON_PREFIX, checkBashCommand, checkWriteContent } from "@roundtable/knight-core";

export { BLOCK_REASON_PREFIX };

/**
 * Guardrails (rules live in the core) shared by both runtimes: the in-process SDK hook (hooks.ts)
 * and the command hook the CLI runtime calls (`node dist/index.js hook
 * pretooluse`, hook-cli.ts). No SDK or metrics imports, so the hook process
 * starts fast.
 */
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
 * Decide a PreToolUse event: a deny output for a blocked Bash command or a Write/Edit/MultiEdit carrying a secret, else
 * undefined (no opinion, Claude Code carries on). The output shape is the same
 * for SDK callback hooks and CLI command hooks (JSON on stdout, exit 0).
 */
export function decidePreToolUse(input: PreToolUseInput): { reason: string; command: string; output: PreToolUseDeny } | undefined {
  if (input.hook_event_name !== "PreToolUse" || !input.tool_name) return undefined;
  let reason: string | undefined;
  let command = "";
  if (input.tool_name === "Bash") {
    command = String((input.tool_input as { command?: unknown } | undefined)?.command ?? "");
    reason = checkBashCommand(command);
  } else {
    reason = checkWriteContent(input.tool_name, input.tool_input);
  }
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
