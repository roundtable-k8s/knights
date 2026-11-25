// publishResult retries across NATS blinks (#91): fake JetStream client, fake clock.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { InvalidArgumentError } from "@nats-io/transport-node";
import { JetStreamApiError } from "@nats-io/jetstream";
import { publishResult, type PublishResultOptions } from "../src/nats/index.ts";
import type { TaskResult } from "../src/contract/index.ts";

const result: TaskResult = {
  task_id: "t1", knight: "K", success: true, result: "done", duration_ms: 1, cost: 0,
  tokens: { input: 0, output: 0 }, model: "m", timestamp: new Date().toISOString(),
};

/** A js that fails with `errors` in order, then works; a clock that only moves when sleep is called. */
function fixture(errors: unknown[]) {
  let t = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const delivered: string[] = [];
  const opts: PublishResultOptions = {
    js: {
      publish: (async (subject: string) => {
        calls++;
        const e = errors.shift();
        if (e) throw e;
        delivered.push(subject);
        return { seq: 1 };
      }) as never,
    },
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
  };
  return { opts, sleeps, calls: () => calls, delivered };
}

describe("publishResult retry (#91)", () => {
  it("delivers once after two failures, with exponential backoff", async () => {
    const f = fixture([new Error("timeout"), new Error("timeout")]);
    await publishResult("t1", result, { ...f.opts, retryMs: 60_000 });
    assert.equal(f.calls(), 3);
    assert.deepEqual(f.sleeps, [500, 1000]);
    assert.equal(f.delivered.length, 1);
  });

  it("caps the delay at 5 s and gives up once the budget is spent", async () => {
    const f = fixture(Array.from({ length: 100 }, () => new Error("down")));
    await assert.rejects(publishResult("t1", result, { ...f.opts, retryMs: 20_000 }), /down/);
    assert.deepEqual(f.sleeps.slice(0, 5), [500, 1000, 2000, 4000, 5000]);
    assert.ok(Math.max(...f.sleeps) <= 5000);
    assert.equal(f.sleeps.reduce((a, b) => a + b, 0), 20_000);
    assert.equal(f.delivered.length, 0);
  });

  it("makes a single attempt with a zero budget", async () => {
    const f = fixture([new Error("down")]);
    await assert.rejects(publishResult("t1", result, { ...f.opts, retryMs: 0 }), /down/);
    assert.equal(f.calls(), 1);
  });

  it("does not retry an error that cannot succeed", async () => {
    for (const err of [
      InvalidArgumentError.format("payload", "max_payload size exceeded"),
      new JetStreamApiError({ code: 400, err_code: 10000, description: "bad request" }),
    ]) {
      const f = fixture([err]);
      await assert.rejects(publishResult("t1", result, f.opts));
      assert.equal(f.calls(), 1);
      assert.deepEqual(f.sleeps, []);
    }
  });

  it("retries a JetStream API 503 (leader change)", async () => {
    const f = fixture([new JetStreamApiError({ code: 503, err_code: 10008, description: "no leader" })]);
    await publishResult("t1", result, f.opts);
    assert.equal(f.calls(), 2);
  });
});
