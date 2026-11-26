import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACK_WAIT_MS, taskConsumerConfig } from "../src/nats/index.ts";

const fixture = JSON.parse(readFileSync(new URL("../contract/fixtures/consumer.knight-tasks.json", import.meta.url), "utf8"));
const subjects = ["roundtable.tasks.dev.galahad", "roundtable.tasks.plan.galahad"];

test("taskConsumerConfig matches the golden fixture the operator vendors", () => {
  assert.deepEqual(taskConsumerConfig("galahad", subjects), fixture);
});

test("the durable name is <knight>-consumer and the filter is passed through", () => {
  const cfg = taskConsumerConfig("galahad", subjects);
  assert.equal(cfg.durable_name, "galahad-consumer");
  assert.deepEqual(cfg.filter_subjects, subjects);
});

test("max_deliver is 1 and ack_wait is ACK_WAIT_MS in nanoseconds", () => {
  const cfg = taskConsumerConfig("galahad", subjects);
  assert.equal(cfg.max_deliver, 1);
  assert.equal(cfg.ack_wait, ACK_WAIT_MS * 1_000_000);
});

test("an explicit ackWaitMs overrides the default window", () => {
  assert.equal(taskConsumerConfig("galahad", subjects, 1000).ack_wait, 1_000_000_000);
});
