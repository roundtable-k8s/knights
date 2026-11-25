import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activityEventErrors } from "@roundtable/knight-core";

process.env.KNIGHT_WORK_ROOT = mkdtempSync(join(tmpdir(), "pk-work-"));
process.env.KNIGHT_DATA_DIR = mkdtempSync(join(tmpdir(), "pk-data-"));
process.env.POD_NAME = "pod-a";
process.env.NODE_NAME = "node-1";

// Generic activity behaviour (bounds, redaction, rate limit, schema) is tested in packages/core.
const { TaskActivity, listInflight, MAX_EVENT_BYTES, MAX_ARGS_CHARS, MAX_PREVIEW_CHARS, handleIntrospect: coreIntrospect } = await import("@roundtable/knight-core");
const { executeTask, onSessionEvent, __setSessionFactoryForTests } = await import("../src/knight.ts");
const { introspectOptions } = await import("../src/session-source.ts");
const handleIntrospect = (req: any, cfg: any) => coreIntrospect(req, introspectOptions(cfg));

const config = {
  knightName: "k", knightModel: "x/y", natsResultsPrefix: "rt.results",
  sessionRetentionMaxFiles: 0, sessionRetentionDays: 0, maxConcurrentTasks: 2,
} as any;

type Pub = { subject: string; ev: any };
const pubs: Pub[] = [];
const publish = (subject: string, data: string) => {
  assert.ok(Buffer.byteLength(data) <= MAX_EVENT_BYTES, "event over 8 KiB");
  pubs.push({ subject, ev: JSON.parse(data) });
};
function capture(): Pub[] {
  pubs.length = 0;
  return pubs;
}
function activity(meta: { taskId: string; runId?: string; chainName?: string; stepName?: string; slot?: number }) {
  return new TaskActivity({
    knight: config.knightName, prefix: "rt", identity: { pod: "pod-a", node: "node-1" },
    model: "x/y", concurrency: 2, publish, ...meta,
  });
}

const GHP = "ghp_" + "a".repeat(40);

test("pi session events map to activity events with redaction and bounds", () => {
  const pubs = capture();
  const a = activity({ taskId: "t1", runId: "r1", chainName: "c", stepName: "s", slot: 0 });
  a.started();
  onSessionEvent(a, { type: "tool_execution_start", toolCallId: "1", toolName: "bash",
    args: { command: `echo ${GHP} ${"x".repeat(500)}`, content: "FILE CONTENTS" } });
  onSessionEvent(a, { type: "tool_execution_end", toolCallId: "1", toolName: "bash", isError: false, durationMs: 12,
    result: { content: [{ type: "text", text: `token ${GHP} ` + "y".repeat(2000) }] } });
  onSessionEvent(a, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "ignored" }] } });
  onSessionEvent(a, { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }, { type: "toolCall", id: "x" }],
    usage: { input: 10, output: 5, cacheRead: 2, cost: { total: 0.5 } } } });
  a.heartbeat();
  a.finished({ success: true });

  assert.deepEqual(pubs.map((p) => p.ev.type),
    ["task.started", "tool.started", "tool.finished", "assistant.message", "task.heartbeat", "task.finished"]);
  assert.deepEqual(pubs.map((p) => p.ev.seq), [1, 2, 3, 4, 5, 6]);
  for (const p of pubs) assert.deepEqual(activityEventErrors(p.ev), [], `${p.ev.type} matches the activity v1 schema`);
  assert.equal(pubs[0].subject, "rt.activity.k.t1");
  assert.equal(pubs[0].ev.node, "node-1");
  assert.equal(pubs[0].ev.slot, 0);
  const all = JSON.stringify(pubs.map((p) => p.ev));
  assert.ok(!all.includes(GHP), "secret leaked");
  assert.ok(!all.includes("FILE CONTENTS"), "file content leaked");
  assert.equal(pubs[1].ev.toolCallId, "1");
  assert.ok(pubs[1].ev.argsSummary.length <= MAX_ARGS_CHARS);
  assert.equal(pubs[1].ev.truncated, true);
  assert.ok(pubs[2].ev.outputPreview.length <= MAX_PREVIEW_CHARS);
  assert.equal(pubs[2].ev.durationMs, 12);
  assert.equal(pubs[3].ev.preview, "hello");
  assert.equal(pubs[4].ev.inputTokens, 10);
  assert.equal(pubs[4].ev.outputTokens, 5);
  assert.equal(pubs[4].ev.costUsd, 0.5);
  assert.equal(pubs[4].ev.turns, 1);
  assert.equal(listInflight().length, 0);
});

// ─── Concurrent runs ────────────────────────────────────────────────

function fakeSession(id: number, gate: Promise<void>) {
  const listeners = new Set<(e: any) => void>();
  const messages: any[] = [];
  const emit = (e: any) => listeners.forEach((l) => l(e));
  return {
    messages,
    subscribe: (l: (e: any) => void) => { listeners.add(l); return () => void listeners.delete(l); },
    dispose() {}, abort() {},
    sessionManager: { getSessionFile: () => `/nonexistent/s${id}.jsonl`, getEntries: () => [], getTree: () => [] },
    model: { id: "default" },
    async setModel() {},
    getSessionStats: () => ({ sessionId: `s${id}`, totalMessages: 0, userMessages: 0, assistantMessages: 0, cost: 0, toolCalls: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, total: 0 } }),
    getLastAssistantText: () => "done",
    async prompt(t: string) {
      emit({ type: "tool_execution_start", toolCallId: `c${id}`, toolName: "bash", args: { command: `run-${t}` } });
      await gate;
      emit({ type: "tool_execution_end", toolCallId: `c${id}`, toolName: "bash", isError: false, durationMs: 1, result: { content: [{ type: "text", text: `out-${t}` }] } });
      messages.push({ role: "assistant", content: [{ type: "text", text: `done ${t}` }] });
    },
  };
}

test("two concurrent runs produce separate event streams; introspect reports inflight + runId selector", async () => {
  const pubs = capture();
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let n = 0;
  __setSessionFactoryForTests(async () => fakeSession(++n, gate) as any);

  const run = (taskId: string, runId: string) => {
    const act = activity({ taskId, runId, slot: taskId === "ta" ? 0 : 1 });
    act.started();
    return executeTask(taskId, config, undefined, runId, taskId, { activity: act })
      .then(() => act.finished({ success: true }));
  };
  const pa = run("ta", "run-A");
  const pb = run("tb", "run-B");
  await new Promise((r) => setTimeout(r, 100));

  const stats: any = await handleIntrospect({ type: "stats" }, config);
  assert.equal(stats.runtime.activeTasks, 2);
  assert.deepEqual(stats.inflight.map((i: any) => i.runId).sort(), ["run-A", "run-B"]);
  assert.equal(stats.pod, "pod-a");
  assert.equal(stats.node, "node-1");
  const a: any = await handleIntrospect({ type: "stats", runId: "run-A" }, config);
  const b: any = await handleIntrospect({ type: "stats", runId: "run-B" }, config);
  assert.notEqual(a.session.sessionId, b.session.sessionId);
  const missing: any = await handleIntrospect({ type: "recent", runId: "nope" }, config);
  assert.match(missing.error, /nope/);

  open();
  await Promise.all([pa, pb]);

  for (const [taskId, runId] of [["ta", "run-A"], ["tb", "run-B"]]) {
    const mine = pubs.filter((p) => p.ev.taskId === taskId);
    assert.deepEqual(mine.map((p) => p.ev.type), ["task.started", "tool.started", "tool.finished", "task.finished"]);
    assert.ok(mine.every((p) => p.ev.runId === runId && p.subject === `rt.activity.k.${taskId}`));
    assert.ok(mine[1].ev.argsSummary.includes(`run-${taskId}`));
    assert.ok(mine[2].ev.outputPreview.includes(`out-${taskId}`));
  }
  assert.equal(((await handleIntrospect({ type: "stats" }, config)) as any).runtime.activeTasks, 0);
});
