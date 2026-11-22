/**
 * Claude Code hooks for the sdk runtime: the same bash guardrails pi-knight
 * enforces, plus tool metrics. Registered as SDK callback hooks, so they run in
 * this process and apply even with permissionMode "bypassPermissions". The cli
 * runtime uses a command hook with the same rules instead (hook-cli.ts).
 */
import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { decidePreToolUse } from "./guardrails.js";
import { log } from "./logger.js";
import { toolCallsBlocked, toolCallsTotal } from "./metrics.js";

export { BLOCKED_BASH_PATTERNS, checkBashCommand } from "./guardrails.js";

async function preToolUse(input: HookInput) {
  const decision = decidePreToolUse(input);
  if (!decision) return {};
  log.warn("Blocked dangerous bash command", { reason: decision.reason, command: decision.command.slice(0, 200) });
  toolCallsBlocked.inc({ tool: "Bash", reason: decision.reason });
  return decision.output;
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
