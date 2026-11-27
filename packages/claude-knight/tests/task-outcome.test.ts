import assert from "node:assert/strict";
import { test } from "node:test";
import { publishTaskOutcome, startTaskScope } from "@roundtable/knight-core";
import { registry } from "../src/runtime-metrics.js";
import { recordPublishFailed, recordReserveRefusal, recordTaskOutcome } from "../src/task-metrics.js";
import type { TaskResult } from "../src/result.js";

const ran: TaskResult = {
  result: "done", success: true, cost: 0.1, billing: "api", model: "m",
  tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, turns: 1,
} as TaskResult;

const count = async (status: string): Promise<number> => {
  const m = await registry.getSingleMetricAsString("roundtable_knight_tasks_total");
  const hit = m.match(new RegExp(`status="${status}"[^}]*\\} (\\d+)`));
  return hit ? Number(hit[1]) : 0;
};

test("a publish failure counts publish_failed and publishes no second, made-up result", async () => {
  const published: string[] = [];
  const before = await count("publish_failed");
  await publishTaskOutcome({
    taskId: "t1",
    record: () => recordTaskOutcome(ran, 1000),
    payload: () => ({}) as never,
    publish: async (id) => {
      published.push(id);
      throw new Error("nats down");
    },
    onPublishFailed: recordPublishFailed,
  });
  assert.deepEqual(published, ["t1"]);
  assert.equal(await count("publish_failed"), before + 1);
});

test("a reserve refusal is recorded as refused, and closing its scope twice acks only once", async () => {
  const calls: string[] = [];
  const delivery = { working: () => calls.push("working"), ack: () => calls.push("ack") };
  const scope = startTaskScope({ delivery, timeoutMs: 60_000 });
  const before = await count("refused");
  await publishTaskOutcome({
    taskId: "t2",
    record: recordReserveRefusal,
    payload: () => ({}) as never,
    publish: async () => {},
    onPublishFailed: recordPublishFailed,
  });
  scope.close();
  scope.close();
  assert.equal(await count("refused"), before + 1);
  assert.deepEqual(calls, ["ack"]);
});
