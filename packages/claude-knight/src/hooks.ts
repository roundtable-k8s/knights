/**
 * Claude Code hooks: the same bash guardrails pi-knight enforces, plus tool
 * metrics. Registered as SDK callback hooks, so they run in this process and
 * apply even with permissionMode "bypassPermissions".
 */
import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger.js";
import { toolCallsBlocked, toolCallsTotal } from "./metrics.js";

export const BLOCKED_BASH_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+\/(?:\s|$|\*)/, reason: "Recursive delete at root level" },
  { pattern: /\bgit\s+push\b.*--force(?!-with-lease)\b/, reason: "Force push without lease (use --force-with-lease or new commits)" },
  { pattern: /\bgit\s+push\b.*\s-f\b/, reason: "Force push (use new commits instead)" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "World-writable permissions" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: "Piping remote script to shell" },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: "Direct device write" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "Filesystem format" },
];

export function checkBashCommand(command: string): string | undefined {
  for (const { pattern, reason } of BLOCKED_BASH_PATTERNS) {
    if (pattern.test(command)) return reason;
  }
  return undefined;
}

async function preToolUse(input: HookInput) {
  if (input.hook_event_name !== "PreToolUse") return {};
  if (input.tool_name !== "Bash") return {};
  const command = String((input.tool_input as { command?: unknown })?.command ?? "");
  const reason = checkBashCommand(command);
  if (!reason) return {};
  log.warn("Blocked dangerous bash command", { reason, command: command.slice(0, 200) });
  toolCallsBlocked.inc({ tool: "Bash", reason });
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const,
      permissionDecisionReason: `Blocked by knight safety policy: ${reason}`,
    },
  };
}

async function postToolUse(input: HookInput) {
  if (input.hook_event_name === "PostToolUse") {
    toolCallsTotal.inc({ tool: input.tool_name, status: "success" });
  } else if (input.hook_event_name === "PostToolUseFailure") {
    toolCallsTotal.inc({ tool: input.tool_name, status: "error" });
  }
  return {};
}

export function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ matcher: "Bash", hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUse] }],
  };
}
