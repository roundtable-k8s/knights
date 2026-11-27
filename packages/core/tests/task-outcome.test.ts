// publishTaskOutcome: metrics first, then publish; never rejects (#91).
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { TaskResult } from "../src/contract/index.ts";
import { publishTaskOutcome } from "../src/task-outcome.ts";

const result = { task_id: "t1", knight: "K", success: true, result: "ok", duration_ms: 1, cost: 0 } as TaskResult;

describe("publishTaskOutcome", () => {
  it("records before publishing and builds the payload once", async () => {
    const calls: string[] = [];
    let built = 0;
    await publishTaskOutcome({
      taskId: "t1",
      record: () => { calls.push("record"); },
      payload: () => { built++; calls.push("payload"); return result; },
      publish: async (id, p) => { calls.push(`publish:${id}`); assert.equal(p, result); },
      onPublishFailed: () => calls.push("failed"),
    });
    assert.deepEqual(calls, ["record", "payload", "publish:t1"]);
    assert.equal(built, 1);
  });

  it("hands traceHeaders to publish, and none when unset", async () => {
    const seen: Array<Record<string, string> | undefined> = [];
    const base = { taskId: "t1", record: () => {}, payload: () => result, onPublishFailed: () => assert.fail("publish succeeded") };
    const publish = async (_id: string, _p: TaskResult, o: { traceHeaders?: Record<string, string> }) => { seen.push(o.traceHeaders); };
    const h = { traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01" };
    await publishTaskOutcome({ ...base, publish, traceHeaders: h });
    await publishTaskOutcome({ ...base, publish });
    assert.deepEqual(seen, [h, undefined]);
  });

  it("calls onPublishFailed once and resolves when publish rejects", async () => {
    let failed = 0;
    await publishTaskOutcome({
      taskId: "t1", record: () => {}, payload: () => result,
      publish: async () => { throw new Error("nats down"); },
      onPublishFailed: () => { failed++; },
    });
    assert.equal(failed, 1);
  });

  it("still publishes when record throws", async () => {
    let published = 0;
    await publishTaskOutcome({
      taskId: "t1", record: () => { throw new Error("metrics bug"); }, payload: () => result,
      publish: async () => { published++; },
      onPublishFailed: () => assert.fail("publish succeeded"),
    });
    assert.equal(published, 1);
  });

  it("resolves when payload construction throws", async () => {
    let failed = 0;
    await publishTaskOutcome({
      taskId: "t1", record: () => {}, payload: () => { throw new Error("bad"); },
      publish: async () => assert.fail("not reached"),
      onPublishFailed: () => { failed++; },
    });
    assert.equal(failed, 1);
  });
});
