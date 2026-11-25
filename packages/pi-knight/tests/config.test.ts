import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";

const env = { KNIGHT_NAME: "k", SUBSCRIBE_TOPICS: "a.>, b.>" };

test("pi-knight config defaults", () => {
  const c = loadConfig(env);
  assert.equal(c.knightName, "k");
  assert.deepEqual(c.subscribeTopics, ["a.>", "b.>"]);
  assert.equal(c.knightModel, "openrouter/deepseek/deepseek-v3.2");
  assert.equal(c.natsUrl, "nats://nats.database.svc.cluster.local:4222");
  assert.equal(c.natsTasksStream, "fleet_a_tasks");
  assert.equal(c.natsResultsStream, "fleet_a_results");
  assert.equal(c.natsResultsPrefix, "fleet-a.results");
  assert.equal(c.taskTimeoutMs, 1_800_000);
  assert.equal(c.drainTimeoutMs, 1_860_000);
  assert.equal(c.maxConcurrentTasks, 2);
  assert.equal(c.metricsPort, 3000);
  assert.equal(c.logLevel, "info");
  assert.equal(c.thinkingLevel, "off");
  assert.equal(c.activityContent, "preview");
});

test("pi-knight config env overrides and required vars", () => {
  const c = loadConfig({ ...env, TASK_TIMEOUT_MS: "1000", METRICS_PORT: "9", ACTIVITY_CONTENT: "none", MAX_CONCURRENT_TASKS: "4" });
  assert.equal(c.drainTimeoutMs, 61_000);
  assert.equal(c.metricsPort, 9);
  assert.equal(c.activityContent, "none");
  assert.equal(c.maxConcurrentTasks, 4);
  assert.throws(() => loadConfig({ KNIGHT_NAME: "k" }), /SUBSCRIBE_TOPICS/);
});
