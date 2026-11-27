import assert from "node:assert/strict";
import { test } from "node:test";
import { startTaskScope, type ParsedTask } from "@roundtable/knight-core";
import type { KnightConfig } from "../src/config.js";
import { refuseForReserve } from "../src/reserve-refusal.js";
import { registry } from "../src/runtime-metrics.js";
import type { TaskResult } from "../src/result.js";

const config = { knightName: "k1", authMode: "subscription", claudeModel: "m1" } as unknown as KnightConfig;
const parsed = (taskId: string): ParsedTask => ({ taskId, prompt: "p" }) as unknown as ParsedTask;

const count = async (status: string): Promise<number> => {
  const m = await registry.getSingleMetricAsString("roundtable_knight_tasks_total");
  const hit = m.match(new RegExp(`status="${status}"[^}]*\\} (\\d+)`));
  return hit ? Number(hit[1]) : 0;
};

const fakeDelivery = () => {
  const calls: string[] = [];
  return { calls, delivery: { working: () => calls.push("working"), ack: () => calls.push("ack") } };
};

const fakeActivity = () => {
  const finished: unknown[] = [];
  return { finished, activity: { finished: (f: unknown) => finished.push(f) } as never };
};

test("a reserve refusal publishes one refused result, records the refusal and acks once", async () => {
  const { calls, delivery } = fakeDelivery();
  const scope = startTaskScope({ delivery, timeoutMs: 60_000 });
  const { finished, activity } = fakeActivity();
  const published: Array<{ id: string; result: TaskResult }> = [];
  const refusedBefore = await count("refused");

  await refuseForReserve({
    parsed: parsed("t1"),
    scope,
    reason: "weekly quota 95%",
    config,
    started: Date.now(),
    activity,
    publish: async (id, result) => {
      published.push({ id, result: result as unknown as TaskResult });
    },
  });

  assert.equal(published.length, 1);
  assert.equal(published[0].id, "t1");
  const payload = published[0].result as unknown as Record<string, unknown>;
  assert.equal(payload.task_id, "t1");
  assert.equal(payload.knight, "k1");
  assert.equal(payload.success, false);
  assert.equal(payload.refused, "quota");
  assert.equal(payload.usage_limited, true);
  assert.equal(await count("refused"), refusedBefore + 1);
  assert.equal(finished.length, 1);
  assert.deepEqual(calls, ["ack"]);
});

test("a refusal whose publish rejects counts publish_failed and still acks once", async () => {
  const { calls, delivery } = fakeDelivery();
  const scope = startTaskScope({ delivery, timeoutMs: 60_000 });
  const { activity } = fakeActivity();
  const failedBefore = await count("publish_failed");

  await refuseForReserve({
    parsed: parsed("t2"),
    scope,
    reason: "quota",
    config,
    started: Date.now(),
    activity,
    publish: async () => {
      throw new Error("nats down");
    },
  });

  assert.equal(await count("publish_failed"), failedBefore + 1);
  assert.deepEqual(calls, ["ack"]);
});
