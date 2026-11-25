/**
 * Claude Code hooks for the sdk runtime: the same guardrails pi-knight
 * enforces (bash commands, secret writes), plus tool metrics. Registered as SDK callback hooks, so they run in
 * this process and apply even with permissionMode "bypassPermissions". The cli
 * runtime uses a command hook with the same rules instead (hook-cli.ts).
 */
import type { HookCallbackMatcher, HookEvent, HookInput } from "@anthropic-ai/claude-agent-sdk";
import { decidePreToolUse } from "./guardrails.js";
import { log } from "@roundtable/knight-core";
import { toolCallDuration, toolCallsBlocked, toolCallsTotal } from "./runtime-metrics.js";

export { BLOCKED_BASH_PATTERNS, checkBashCommand } from "@roundtable/knight-core";

/** tool_use_id → start time (ms); filled by PreToolUse, drained by PostToolUse[Failure]. */
const toolStarts = new Map<string, number>();

async function preToolUse(input: HookInput) {
  const decision = decidePreToolUse(input);
  if (!decision) return {};
  // A blocked call never runs, so no PostToolUse follows to drain its start time.
  if (input.hook_event_name === "PreToolUse") toolStarts.delete(input.tool_use_id);
  if (input.hook_event_name === "PreToolUse" && input.tool_name === "Bash") {
    log.warn("Blocked dangerous bash command", { reason: decision.reason, command: decision.command.slice(0, 200) });
  } else {
    log.warn("Blocked secret write", { tool: "tool_name" in input ? input.tool_name : undefined, reason: decision.reason });
  }
  toolCallsBlocked.inc({ tool: "tool_name" in input ? input.tool_name : "Bash", reason: decision.reason });
  return decision.output;
}

async function startTimer(input: HookInput) {
  if (input.hook_event_name === "PreToolUse") toolStarts.set(input.tool_use_id, Date.now());
  return {};
}

async function postToolUse(input: HookInput) {
  if (input.hook_event_name === "PostToolUse" || input.hook_event_name === "PostToolUseFailure") {
    const started = toolStarts.get(input.tool_use_id);
    toolStarts.delete(input.tool_use_id);
    if (started !== undefined) toolCallDuration.observe({ tool: input.tool_name }, (Date.now() - started) / 1000);
  }
  if (input.hook_event_name === "PostToolUse") {
    toolCallsTotal.inc({ tool: input.tool_name, status: "success" });
  } else if (input.hook_event_name === "PostToolUseFailure") {
    toolCallsTotal.inc({ tool: input.tool_name, status: "error" });
  }
  return {};
}

export function buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [{ hooks: [startTimer] }, { matcher: "Bash|Write|Edit|MultiEdit", hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUse] }],
  };
}
