/**
 * The sdk runtime's callback hooks (buildHooks): one PreToolUse callback runs the guardrails
 * and starts the tool timer, PostToolUse[Failure] records the duration, and a blocked call
 * leaves no start time behind.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { BLOCK_REASON_PREFIX, setLogStream } from "@roundtable/knight-core";
import { buildHooks, pendingToolStarts } from "../src/hooks.js";
import { toolCallDuration } from "../src/runtime-metrics.js";

const signal = new AbortController().signal;
const callOptions = { signal } as never;
const base = { session_id: "s", transcript_path: "/t", cwd: "/" };

function preToolUseHook() {
  const [hook] = (buildHooks().PreToolUse ?? []).flatMap((m) => m.hooks);
  assert.ok(hook, "PreToolUse has a callback");
  return hook!;
}

/** Observation count of toolCallDuration for one tool label. */
async function durationCount(tool: string): Promise<number> {
  const { values } = await toolCallDuration.get();
  return values
    .filter((v) => v.metricName?.endsWith("_count") && v.labels["tool"] === tool)
    .reduce((n, v) => n + v.value, 0);
}

function quietLogs<T>(fn: () => Promise<T>): Promise<T> {
  setLogStream(new PassThrough());
  return fn().finally(() => setLogStream(process.stdout));
}

test("buildHooks runs the guardrail and the timer in one PreToolUse callback", () => {
  const pre = buildHooks().PreToolUse ?? [];
  assert.equal(pre.length, 1, "a single PreToolUse entry, so the guardrail and the timer cannot race");
  assert.equal(pre[0]!.matcher, undefined, "applies to every tool so every call is timed");
  assert.equal(pre[0]!.hooks.length, 1);
});

test("buildHooks PreToolUse denies a Write carrying a token-shaped secret and allows a harmless one", async () => {
  const hook = preToolUseHook();
  const token = `ghp_${"a".repeat(36)}`;

  const denied = (await quietLogs(() =>
    hook({ ...base, hook_event_name: "PreToolUse", tool_use_id: "tu1", tool_name: "Write", tool_input: { file_path: "/x", content: `T=${token}` } } as never, "tu1", callOptions),
  )) as { hookSpecificOutput?: { permissionDecision: string; permissionDecisionReason: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.ok(denied.hookSpecificOutput!.permissionDecisionReason.startsWith(BLOCK_REASON_PREFIX));
  assert.equal(denied.hookSpecificOutput!.permissionDecisionReason, `${BLOCK_REASON_PREFIX}secret_in_content`);

  const allowed = await hook(
    { ...base, hook_event_name: "PreToolUse", tool_use_id: "tu2", tool_name: "Write", tool_input: { file_path: "/x", content: "const a = 1;\n" } } as never,
    "tu2",
    callOptions,
  );
  assert.deepEqual(allowed, {});
  assert.equal(pendingToolStarts(), 1, "only the allowed call is timed");
  await buildHooks().PostToolUse![0]!.hooks[0]!(
    { ...base, hook_event_name: "PostToolUse", tool_use_id: "tu2", tool_name: "Write" } as never,
    "tu2",
    callOptions,
  );
  assert.equal(pendingToolStarts(), 0);
});

test("PreToolUse then PostToolUse records one tool duration and drains the start time", async () => {
  const hook = preToolUseHook();
  const post = buildHooks().PostToolUse![0]!.hooks[0]!;
  const before = await durationCount("Read");

  await hook({ ...base, hook_event_name: "PreToolUse", tool_use_id: "read1", tool_name: "Read", tool_input: {} } as never, "read1", callOptions);
  assert.equal(pendingToolStarts(), 1);
  await post({ ...base, hook_event_name: "PostToolUse", tool_use_id: "read1", tool_name: "Read" } as never, "read1", callOptions);

  assert.equal(pendingToolStarts(), 0);
  assert.equal(await durationCount("Read"), before + 1);
});

test("a blocked Bash call leaves no start time, so a later call with the same id records no duration", async () => {
  const hook = preToolUseHook();
  const post = buildHooks().PostToolUse![0]!.hooks[0]!;
  const before = await durationCount("Read");

  const denied = (await quietLogs(() =>
    hook({ ...base, hook_event_name: "PreToolUse", tool_use_id: "dup", tool_name: "Bash", tool_input: { command: "rm -rf /" } } as never, "dup", callOptions),
  )) as { hookSpecificOutput?: { permissionDecision: string } };
  assert.equal(denied.hookSpecificOutput?.permissionDecision, "deny");
  assert.equal(pendingToolStarts(), 0, "the blocked call's start time is not stored");

  // an unrelated call that reuses the id finishes without a bogus duration
  await post({ ...base, hook_event_name: "PostToolUse", tool_use_id: "dup", tool_name: "Read" } as never, "dup", callOptions);
  assert.equal(await durationCount("Read"), before);
});
