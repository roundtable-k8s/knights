import assert from "node:assert/strict";
import { test } from "node:test";
import {
  activityPreview,
  inflightTasks,
  MAX_EVENT_BYTES,
  podIdentity,
  redactSecrets,
  registerActivity,
  TaskActivity,
  unregisterActivity,
} from "../src/activity.js";
import { applyMessage, newStreamState } from "../src/stream.js";

function make(taskId: string, out: { subject: string; ev: Record<string, any> }[], extra: object = {}, now = () => 1_000_000) {
  return new TaskActivity({
    knight: "K",
    taskId,
    subject: `p.activity.K.${taskId}`,
    identity: { pod: "pod-a", node: "node-1" },
    runId: `run-${taskId}`,
    publish: (subject, payload) => out.push({ subject, ev: JSON.parse(payload) }),
    now,
    ...extra,
  });
}

test("redaction removes tokens, Authorization headers and env dumps", () => {
  const input = [
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "key sk-ant-api03-abcdefghijklmnop",
    "Authorization: Bearer abcdefghijklmnop1234",
    "GITHUB_TOKEN=ghs_zzzzzzzzzzzzzzzzzzzzzzzz",
    "CLAUDE_CODE_OAUTH_TOKEN=oauth-value-123",
    '{"password": "hunter2hunter2"}',
    "https://user:pa55word@example.com/x",
    "AKIAABCDEFGHIJKLMNOP",
  ].join("\n");
  const out = redactSecrets(input);
  for (const leak of ["ghp_abc", "sk-ant-api03", "abcdefghijklmnop1234", "ghs_zzz", "oauth-value-123", "hunter2", "pa55word", "AKIAABCDEFGHIJKLMNOP"]) {
    assert.ok(!out.includes(leak), `leaked ${leak}: ${out}`);
  }
  assert.match(out, /\[REDACTED\]/);
});

test("preview is truncated to 500 chars and flagged", () => {
  const p = activityPreview("x".repeat(2000));
  assert.equal(p.text.length, 500);
  assert.equal(p.truncated, true);
  assert.equal(activityPreview("short").truncated, false);
});

test("pod identity falls back to hostname", () => {
  assert.deepEqual(podIdentity({}, "h"), { pod: "h", node: "h" });
  assert.deepEqual(podIdentity({ POD_NAME: "p", NODE_NAME: "n" }, "h"), { pod: "p", node: "n" });
});

test("events carry pod, taskId, runId, monotonic seq; never exceed 8 KiB", () => {
  const out: { subject: string; ev: Record<string, any> }[] = [];
  const a = make("t1", out);
  a.started();
  a.toolStarted("u1", "Bash", { command: "echo $X " + "y".repeat(5000), env: { SECRET: "s3cr3t" } });
  a.toolFinished("u1", "Bash", false, "o".repeat(20000));
  a.assistantMessage("hello Authorization: Bearer abcdefghijklmnop1234");
  a.heartbeat();
  a.finished({ success: true, cost: 0.1 });
  assert.deepEqual(out.map((o) => o.ev.type), ["task.started", "tool.started", "tool.finished", "assistant.message", "task.heartbeat", "task.finished"]);
  assert.deepEqual(out.map((o) => o.ev.seq), [1, 2, 3, 4, 5, 6]);
  for (const { subject, ev } of out) {
    assert.equal(subject, "p.activity.K.t1");
    assert.equal(ev.pod, "pod-a");
    assert.equal(ev.taskId, "t1");
    assert.equal(ev.runId, "run-t1");
    assert.ok(JSON.stringify(ev).length <= MAX_EVENT_BYTES);
  }
  assert.ok(!JSON.stringify(out).includes("s3cr3t"));
  assert.ok(!JSON.stringify(out).includes("abcdefghijklmnop1234"));
  assert.ok(out[1]!.ev.args.length <= 200);
});

test("rate limit drops tool events above 20/s but never lifecycle events", () => {
  const out: { subject: string; ev: Record<string, any> }[] = [];
  const a = make("t2", out);
  a.started();
  for (let i = 0; i < 50; i++) a.toolStarted(`u${i}`, "Read", { file_path: "/x" });
  a.heartbeat();
  a.finished({ success: true });
  assert.equal(out.filter((o) => o.ev.type === "tool.started").length, 20);
  assert.ok(out.some((o) => o.ev.type === "task.heartbeat"));
  assert.ok(out.some((o) => o.ev.type === "task.finished"));
  // seq has gaps only for dropped events: none are assigned to them
  assert.deepEqual(out.map((o) => o.ev.seq), out.map((_, i) => i + 1));
});

test("activityContent none omits previews", () => {
  const out: { subject: string; ev: Record<string, any> }[] = [];
  const a = make("t3", out, { content: "none" });
  a.toolStarted("u", "Bash", { command: "ls" });
  a.toolFinished("u", "Bash", false, "secret output");
  a.assistantMessage("hi");
  for (const { ev } of out) {
    assert.equal(ev.args, undefined);
    assert.equal(ev.output, undefined);
    assert.equal(ev.text, undefined);
  }
});

test("publish failures never throw", () => {
  const a = new TaskActivity({ knight: "K", taskId: "t", subject: "s", identity: { pod: "p", node: "n" }, publish: () => { throw new Error("down"); } });
  assert.doesNotThrow(() => { a.started(); a.finished({ success: false }); });
});

test("two concurrent tasks produce separate, correctly keyed streams via applyMessage", () => {
  const out: { subject: string; ev: Record<string, any> }[] = [];
  const a = make("A", out);
  const b = make("B", out);
  registerActivity(a, "A");
  registerActivity(b, "B");
  try {
    const cfg = { knightName: "K" } as never;
    const sa = newStreamState();
    const sb = newStreamState();
    for (const countTools of [true, false]) {
      const ca = { config: cfg, taskId: "A", countTools };
      const cb = { config: cfg, taskId: "B", countTools };
      applyMessage({ type: "assistant", message: { content: [{ type: "tool_use", id: "a1", name: "Bash", input: { command: "ls" } }] } } as never, sa, ca);
      applyMessage({ type: "assistant", message: { content: [{ type: "text", text: "working on B" }, { type: "tool_use", id: "b1", name: "Read", input: { file_path: "/f" } }] } } as never, sb, cb);
      applyMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a1", content: "done", is_error: false }] } } as never, sa, ca);
      applyMessage({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b1", content: "oops", is_error: true }] } } as never, sb, cb);
    }
    const byTask = (id: string) => out.filter((o) => o.ev.taskId === id);
    assert.ok(out.every((o) => o.subject === `p.activity.K.${o.ev.taskId}`));
    assert.deepEqual(byTask("A").map((o) => o.ev.type), ["tool.started", "tool.finished", "tool.started", "tool.finished"]);
    assert.deepEqual(byTask("B").map((o) => o.ev.type), ["assistant.message", "tool.started", "tool.finished", "assistant.message", "tool.started", "tool.finished"]);
    assert.deepEqual(byTask("A").map((o) => o.ev.seq), [1, 2, 3, 4]);
    assert.equal(byTask("B").find((o) => o.ev.type === "tool.finished")!.ev.isError, true);
    assert.equal(byTask("A")[1]!.ev.tool, "Bash");
    assert.deepEqual(inflightTasks().map((t) => t.taskId).sort(), ["A", "B"]);
  } finally {
    unregisterActivity("A");
    unregisterActivity("B");
  }
  assert.equal(inflightTasks().length, 0);
});

test("inflight shape", () => {
  const a = make("T", [], { chainName: "c", stepName: "s", model: "m" });
  a.workDir = "work";
  a.heartbeat();
  const i = a.inflight();
  assert.equal(i.taskId, "T");
  assert.equal(i.chainName, "c");
  assert.equal(i.workDir, "work");
  assert.ok(i.lastHeartbeatAt);
});
