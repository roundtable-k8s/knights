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

/** Tools the guardrail reads; other tools are only timed. */
const GUARDED_TOOLS = /^(?:Bash|Write|Edit|MultiEdit)$/;

/**
 * One PreToolUse callback for every tool: the guardrail decides first, and only a
 * call that is allowed gets a start time. Running both in one callback keeps the
 * order fixed, so a blocked call never leaves a start time behind for a later
 * PostToolUse with the same id.
 */
async function preToolUse(input: HookInput) {
  if (input.hook_event_name !== "PreToolUse") return {};
  const decision = GUARDED_TOOLS.test(input.tool_name) ? decidePreToolUse(input) : undefined;
  if (!decision) {
    toolStarts.set(input.tool_use_id, Date.now());
    return {};
  }
  if (input.tool_name === "Bash") {
    log.warn("Blocked dangerous bash command", { reason: decision.reason, command: decision.command.slice(0, 200) });
  } else {
    log.warn("Blocked secret write", { tool: input.tool_name, reason: decision.reason });
  }
  toolCallsBlocked.inc({ tool: input.tool_name, reason: decision.reason });
  return decision.output;
}

/** Number of tool calls started but not yet finished (test hook). */
export function pendingToolStarts(): number {
  return toolStarts.size;
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
    PreToolUse: [{ hooks: [preToolUse] }],
    PostToolUse: [{ hooks: [postToolUse] }],
    PostToolUseFailure: [{ hooks: [postToolUse] }],
  };
}
