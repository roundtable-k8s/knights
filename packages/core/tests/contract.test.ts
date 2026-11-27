import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeResult, normalizeTimeoutMs, parseTask, taskLimitNote, withTaskLimitNote, type TaskResult } from "../src/contract/index.ts";

test("normalizeTimeoutMs keeps positive finite timeouts", () => {
  assert.equal(normalizeTimeoutMs(1800000), 1800000);
  assert.equal(normalizeTimeoutMs(1), 1);
});

test("normalizeTimeoutMs treats 0 and negatives as unset (the #30 instant-abort bug)", () => {
  assert.equal(normalizeTimeoutMs(0), undefined);
  assert.equal(normalizeTimeoutMs(-5), undefined);
});

test("normalizeTimeoutMs rejects non-finite and non-number inputs", () => {
  assert.equal(normalizeTimeoutMs(NaN), undefined);
  assert.equal(normalizeTimeoutMs(Infinity), undefined);
  assert.equal(normalizeTimeoutMs(undefined), undefined);
  assert.equal(normalizeTimeoutMs(null), undefined);
  assert.equal(normalizeTimeoutMs("1000"), undefined);
});

test("parseTask reads the operator's TaskPayload runId (#31)", () => {
  const raw = JSON.stringify({
    taskId: "chain-dev-plan.3f2a-1732280000000",
    chainName: "dev",
    stepName: "plan",
    runId: "3f2a9c1e-0000-4000-8000-000000000001",
    task: "Plan the change",
  });
  const parsed = parseTask(raw, "subject-id");
  assert.equal(parsed.runId, "3f2a9c1e-0000-4000-8000-000000000001");
  assert.equal(parsed.taskId, "chain-dev-plan.3f2a-1732280000000");
  assert.equal(parsed.task, "Plan the change");
});

test("parseTask accepts snake_case run_id and ignores empty run ids", () => {
  assert.equal(parseTask(JSON.stringify({ task: "x", run_id: "r1" }), "s").runId, "r1");
  assert.equal(parseTask(JSON.stringify({ task: "x", runId: "" }), "s").runId, undefined);
  assert.equal(parseTask(JSON.stringify({ task: "x", runId: "   " }), "s").runId, undefined);
});

test("parseTask marks a payload that breaks the schema invalid, naming the field (#6)", () => {
  const p = parseTask(JSON.stringify({ task_id: "t9", task: "x", runId: 42, from: "galahad" }), "s");
  assert.equal(p.invalid, "runId: must be string");
  assert.equal(p.taskId, "t9", "the result can still be addressed");
  assert.equal(p.from, "galahad", "self-echo filtering still works");
  assert.equal(p.task, "", "an invalid task never runs");
  assert.equal(parseTask(JSON.stringify({ task: 5 }), "s").invalid, "task: must be string");
  assert.equal(parseTask(JSON.stringify({ taskId: "t", metadata: { timeout_ms: "1000" } }), "s").invalid,
    "task: required; metadata.timeout_ms: must be number");
  assert.equal(parseTask(JSON.stringify({ task: "x", attempt: 0 }), "s").invalid, "attempt: must be >= 1");
  assert.equal(parseTask(JSON.stringify({ taskId: 7, task: "x" }), "subj").taskId, "subj");
});

test("parseTask accepts the legacy description/message aliases for task", () => {
  assert.equal(parseTask(JSON.stringify({ description: "d" }), "s").task, "d");
  assert.equal(parseTask(JSON.stringify({ message: "m" }), "s").task, "m");
  assert.equal(parseTask(JSON.stringify({ message: "m" }), "s").invalid, undefined);
});

test("parseTask without runId (ad-hoc task) leaves it undefined", () => {
  const parsed = parseTask(JSON.stringify({ task_id: "t1", task: "hi" }), "s");
  assert.equal(parsed.runId, undefined);
  assert.equal(parsed.taskId, "t1");
});

test("parseTask treats non-JSON and non-object JSON as plain task text", () => {
  assert.deepEqual(parseTask("just do it", "sub"), { task: "just do it", taskId: "sub" });
  assert.deepEqual(parseTask("null", "sub"), { task: "null", taskId: "sub" });
  assert.deepEqual(parseTask('"quoted"', "sub"), { task: '"quoted"', taskId: "sub" });
});

test("parseTask reads an optional per-task model", () => {
  assert.equal(parseTask(JSON.stringify({ task: "x", model: " openrouter/anthropic/claude-sonnet-4.5:floor " }), "s").model, "openrouter/anthropic/claude-sonnet-4.5:floor");
  assert.equal(parseTask(JSON.stringify({ task: "x", model: "" }), "s").model, undefined);
  assert.equal(parseTask(JSON.stringify({ task: "x", model: 5 }), "s").model, undefined);
  assert.equal(parseTask(JSON.stringify({ task: "x" }), "s").model, undefined);
});

test("parseTask treats a JSON array as plain task text", () => {
  assert.deepEqual(parseTask("[1,2]", "id"), { task: "[1,2]", taskId: "id" });
});

test("parseTask accepts every chain/step spelling the dispatchers use", () => {
  for (const [c, s] of [["chainName", "stepName"], ["chain_name", "step_name"], ["chain", "step"]] as [string, string][]) {
    const p = parseTask(JSON.stringify({ task: "x", [c]: "c1", [s]: "s1" }), "id");
    assert.deepEqual([p.chainName, p.stepName], ["c1", "s1"], c);
  }
  const bad = parseTask(JSON.stringify({ task: "x", chainName: 3, stepName: null, step: "s" }), "id");
  assert.equal(bad.invalid, "chainName: must be string; stepName: must be string");
});

test("parseTask sets publishedAtMs only for a parseable timestamp", () => {
  assert.equal(parseTask(JSON.stringify({ task: "x", timestamp: "2026-11-24T10:00:00Z" }), "s").publishedAtMs, Date.parse("2026-11-24T10:00:00Z"));
  assert.equal(parseTask(JSON.stringify({ task: "x", timestamp: "soon" }), "s").publishedAtMs, undefined);
  assert.equal(parseTask(JSON.stringify({ task: "x" }), "s").publishedAtMs, undefined);
});

// ── Recorded wire fixtures ──────────────────────────────────────────
// Payloads as each runtime (and the operator) send them today. The expected parse is
// what the runtimes' former parsers (pi-knight parseTaskPayload, claude-knight
// parseTaskMessage) produced; parseTask is their union.

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8").trim();
const defined = (o: object) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

test("fixture: pi-knight nats_request task payload", () => {
  assert.deepEqual(defined(parseTask(fixture("pi-knight-task"), "subj")), {
    task: "Review PR #12 in roundtable-k8s/knights and reply with a verdict.",
    taskId: "lancelot-1764000000000-a1b2c3",
    domain: "code",
    from: "galahad",
    dispatchedBy: "Galahad",
    timestamp: "2026-11-24T10:00:00.000Z",
    timeoutMs: 600000,
    publishedAtMs: Date.parse("2026-11-24T10:00:00.000Z"),
  });
});

test("fixture: claude-knight nats_request task payload (timeout_ms 0 is unset, #30)", () => {
  assert.deepEqual(defined(parseTask(fixture("claude-knight-task"), "subj")), {
    task: "Summarise the open issues labelled groomed.",
    taskId: "rt-ui-1764000000000-d4e5f6",
    domain: "ui",
    from: "rt-dev",
    dispatchedBy: "rt-dev",
    timestamp: "2026-11-24T10:05:00.000Z",
    publishedAtMs: Date.parse("2026-11-24T10:05:00.000Z"),
  });
});

test("fixture: operator TaskPayload", () => {
  assert.deepEqual(defined(parseTask(fixture("operator-task"), "subj")), {
    task: "Implement sub-issue #49.",
    taskId: "chain-run-7-step-implement",
    timestamp: "2026-11-24T09:59:30Z",
    runId: "5f0c2a8e-1d3b-4c55-9a77-0b6d2a9e4f11",
    chainName: "issue-to-pr",
    stepName: "implement",
    model: "claude-opus-5-5",
    publishedAtMs: Date.parse("2026-11-24T09:59:30Z"),
  });
});

for (const name of ["pi-knight-result", "claude-knight-result"]) {
  test(`fixture: ${name} serialises byte-identically`, () => {
    const raw = fixture(name);
    const result: TaskResult = JSON.parse(raw);
    assert.equal(encodeResult(result), raw);
  });
}

test("refusals: pi-knight sends refused credits, claude-knight refused quota plus deprecated usage_limited (#6)", () => {
  const pi: TaskResult = JSON.parse(fixture("pi-knight-result"));
  const claude: TaskResult = JSON.parse(fixture("claude-knight-result"));
  assert.equal(pi.refused, "credits");
  assert.ok(!("usage_limited" in pi));
  assert.equal(claude.refused, "quota");
  assert.equal(claude.usage_limited, true);
});

// ── Manual retry (#36) ──────────────────────────────────────────────

import { promptWithRetryContext, taskResultFields, failureResult, lostTaskResult, MAX_ECHOED_TASK_BYTES } from "../src/contract/index.ts";

test("parseTask reads attempt, retryOf and previousFailure (capped at 2 KB)", () => {
  const p = parseTask(JSON.stringify({ task: "x", attempt: 2, retryOf: "t-1", previousFailure: "boom".repeat(1000) }), "s");
  assert.equal(p.attempt, 2);
  assert.equal(p.retryOf, "t-1");
  assert.equal(Buffer.byteLength(p.previousFailure!, "utf8"), 2048);
  const multi = parseTask(JSON.stringify({ task: "x", attempt: 2, previousFailure: "é".repeat(3000) }), "s");
  assert.equal(multi.previousFailure, "é".repeat(1024));
  const odd = parseTask(JSON.stringify({ task: "x", attempt: 2, previousFailure: "a" + "€".repeat(1000) }), "s");
  assert.ok(Buffer.byteLength(odd.previousFailure!, "utf8") <= 2048);
  assert.doesNotMatch(odd.previousFailure!, /\uFFFD/);
  const plain = parseTask(JSON.stringify({ task: "x" }), "s");
  assert.equal(plain.attempt, undefined);
  assert.equal(plain.previousFailure, undefined);
  assert.equal(parseTask(JSON.stringify({ task: "x", previousFailure: "  " }), "s").previousFailure, undefined);
});

test("promptWithRetryContext prefixes attempts above 1 only", () => {
  const p = parseTask(JSON.stringify({ task: "Do it", attempt: 2, retryOf: "t-1", previousFailure: "timed out" }), "s");
  const prompt = promptWithRetryContext(p);
  assert.ok(prompt.startsWith("This is attempt 2 of a task that did not finish before (original task `t-1`; previous outcome in the block below).\n\n```\ntimed out\n```\n\nBefore doing anything, check"));
  assert.ok(prompt.endsWith("\n\nDo it"));
  assert.equal(promptWithRetryContext(parseTask(JSON.stringify({ task: "Do it" }), "s")), "Do it");
  assert.equal(promptWithRetryContext(parseTask(JSON.stringify({ task: "Do it", attempt: 1 }), "s")), "Do it");
});

test("promptWithRetryContext fences an outcome with backticks or newlines", () => {
  const outcome = "failed: `rm -rf` ran\n```\nnested\n```` four";
  const prompt = promptWithRetryContext({ task: "Do it", attempt: 2, retryOf: "t-1", previousFailure: outcome });
  assert.ok(prompt.includes(`\n\`\`\`\`\`\n${outcome}\n\`\`\`\`\`\n`), "fence of 5 backticks around the outcome");
  assert.ok(prompt.endsWith("\n\nDo it"));
  assert.ok(promptWithRetryContext({ task: "Do it", attempt: 2 }).includes("\n```\nunknown\n```\n"));
});

test("taskResultFields: attempt/retry_of when set, task only on failure", () => {
  const p = parseTask(JSON.stringify({ taskId: "t-2", task: "Do it", runId: "r", chainName: "c", stepName: "s", model: "m", attempt: 2, retryOf: "t-1" }), "x");
  const ok = taskResultFields(p, true);
  assert.deepEqual(ok, { attempt: 2, retry_of: "t-1" });
  const failed = taskResultFields(p, false);
  assert.deepEqual(failed.task, { taskId: "t-2", task: "Do it", runId: "r", chainName: "c", stepName: "s", model: "m", attempt: 2 });
  assert.deepEqual(taskResultFields(parseTask("plain", "t-3"), true), {});
  assert.equal(taskResultFields(parseTask("plain", "t-3"), false).task?.task, "plain");
});

test("failure echoes cap the task text at 64 KB of UTF-8", () => {
  const big = "é".repeat(MAX_ECHOED_TASK_BYTES);
  const echoed = taskResultFields({ task: big, taskId: "t" }, false).task!.task;
  assert.ok(Buffer.byteLength(echoed) <= MAX_ECHOED_TASK_BYTES);
  assert.ok(!echoed.includes("�"));
});

test("failure and lost results carry the task", () => {
  const parsed = parseTask("hello", "t-4");
  assert.equal(failureResult({ taskId: "t-4", knight: "k", model: "m", error: "e", parsed }).task?.task, "hello");
  const lost = lostTaskResult({ taskId: "t-4", knight: "k", model: "m", parsed });
  assert.equal(lost.lost, true);
  assert.equal(lost.task?.taskId, "t-4");
  assert.equal(failureResult({ taskId: "t-4", knight: "k", model: "m", error: "e" }).task, undefined);
});

const T0 = Date.UTC(2026, 0, 1, 14, 2, 0);

test("taskLimitNote states the limit in minutes and the UTC stop time", () => {
  const note = taskLimitNote(600000, T0);
  assert.match(note, /Time limit for this task: 10 minutes, stopping at 14:12 UTC/);
  assert.match(note, /full test suite at most once/);
});

test("taskLimitNote handles hours, one minute and sub-minute limits", () => {
  assert.match(taskLimitNote(3600000, T0), /1 hour, stopping at 15:02 UTC/);
  assert.match(taskLimitNote(5400000, T0), /1 hour 30 minutes, stopping at 15:32 UTC/);
  assert.match(taskLimitNote(60000, T0), /1 minute, stopping at 14:03 UTC/);
  assert.match(taskLimitNote(30000, T0), /30 seconds, stopping at 14:02 UTC/);
});

test("taskLimitNote rounds to whole seconds before choosing the unit", () => {
  assert.match(taskLimitNote(59999, T0), /Time limit for this task: 1 minute, stopping at 14:02 UTC/);
  assert.match(taskLimitNote(59400, T0), /Time limit for this task: 59 seconds, stopping at 14:02 UTC/);
  assert.match(taskLimitNote(119999, T0), /Time limit for this task: 2 minutes, stopping at 14:03 UTC/);
});

test("withTaskLimitNote appends after the task text and honours KNIGHT_TASK_LIMIT_NOTE=off", () => {
  const out = withTaskLimitNote("do it", 600000, T0, {});
  assert.ok(out.startsWith("do it\n\nTime limit for this task: 10 minutes"));
  assert.equal(withTaskLimitNote("do it", 600000, T0, { KNIGHT_TASK_LIMIT_NOTE: "off" }), "do it");
  assert.ok(withTaskLimitNote("do it", 600000, T0, { KNIGHT_TASK_LIMIT_NOTE: "on" }).length > 5);
});
