// Generic activity behaviour (bounds, redaction, rate limit, schema) is tested in packages/core.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listInflight, SlotPool, TaskActivity } from "@roundtable/knight-core";
import { applyMessage, newStreamState } from "../src/stream.js";

type Pub = { subject: string; ev: Record<string, any> };

function make(taskId: string, out: Pub[]) {
  return new TaskActivity({
    knight: "K",
    prefix: "p",
    taskId,
    identity: { pod: "pod-a", node: "node-1" },
    runId: `run-${taskId}`,
    publish: (subject, payload) => out.push({ subject, ev: JSON.parse(payload) }),
    now: () => 1_000_000,
  });
}

test("two concurrent tasks produce separate, correctly keyed streams via applyMessage", () => {
  const out: Pub[] = [];
  const a = make("A", out);
  const b = make("B", out);
  a.started();
  b.started();
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
    const byTask = (id: string) => out.filter((o) => o.ev.taskId === id && o.ev.type !== "task.started");
    assert.ok(out.every((o) => o.subject === `p.activity.K.${o.ev.taskId}`));
    assert.deepEqual(byTask("A").map((o) => o.ev.type), ["tool.started", "tool.finished", "tool.started", "tool.finished"]);
    assert.deepEqual(byTask("B").map((o) => o.ev.type), ["assistant.message", "tool.started", "tool.finished", "assistant.message", "tool.started", "tool.finished"]);
    assert.deepEqual(byTask("A").map((o) => o.ev.seq), [2, 3, 4, 5]);
    const started = byTask("A")[0]!.ev;
    assert.equal(started.tool, "Bash");
    assert.equal(started.toolCallId, "a1");
    assert.equal(started.argsSummary, "ls");
    const finished = byTask("B").find((o) => o.ev.type === "tool.finished")!.ev;
    assert.equal(finished.isError, true);
    assert.equal(finished.outputPreview, "oops");
    assert.equal(byTask("B")[0]!.ev.preview, "working on B");
    assert.deepEqual(listInflight().map((t) => t.taskId).sort(), ["A", "B"]);
  } finally {
    a.close();
    b.close();
  }
  assert.equal(listInflight().length, 0);
});

test("with concurrency 2, a third task reuses the freed slot instead of sharing the running task's", () => {
  const out: Pub[] = [];
  const slots = new SlotPool();
  // Same wiring as main.ts processTask: acquire before task.started, release when the task ends.
  const start = (id: string) => {
    const slot = slots.acquire();
    const act = new TaskActivity({
      knight: "K", prefix: "p", taskId: id, identity: { pod: "pod-a", node: "node-1" }, runId: `run-${id}`,
      slot, concurrency: 2, publish: (subject, payload) => out.push({ subject, ev: JSON.parse(payload) }), now: () => 1_000_000,
    });
    act.started();
    return () => { act.close(); slots.release(slot); };
  };
  const endA = start("A");
  const endB = start("B");
  endA();
  const endC = start("C");
  try {
    const slotOf = (id: string) => out.find((o) => o.ev.taskId === id && o.ev.type === "task.started")!.ev.slot;
    assert.equal(slotOf("A"), 0);
    assert.equal(slotOf("B"), 1);
    assert.equal(slotOf("C"), 0);
  } finally {
    endB();
    endC();
  }
});
