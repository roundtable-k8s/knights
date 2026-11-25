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

test("pi-knight config survives bad numeric and list settings", () => {
  for (const v of ["abc", "0", "-3"]) assert.equal(loadConfig({ ...env, MAX_CONCURRENT_TASKS: v }).maxConcurrentTasks, 1);
  assert.deepEqual(loadConfig({ KNIGHT_NAME: "k", SUBSCRIBE_TOPICS: "a, ,b," }).subscribeTopics, ["a", "b"]);
  assert.equal(loadConfig({ ...env, TASK_TIMEOUT_MS: "0" }).taskTimeoutMs, 1_800_000);
  const c = loadConfig({ ...env, MAX_RETRY_DELAY_MS: "x", THINKING_BUDGET_LOW: "nan", SESSION_RETENTION_DAYS: "zzz", SESSION_RETENTION_MAX_FILES: "-1" });
  assert.equal(c.maxRetryDelayMs, 60000);
  assert.equal(c.thinkingBudgetLow, 1024);
  assert.equal(c.sessionRetentionDays, 30);
  assert.equal(c.sessionRetentionMaxFiles, 100);
});

test("pi-knight MAX_RETRY_DELAY_MS=0 stays 0 (no cap); invalid values fall back", () => {
  assert.equal(loadConfig({ ...env, MAX_RETRY_DELAY_MS: "0" }).maxRetryDelayMs, 0);
  assert.equal(loadConfig({ ...env, MAX_RETRY_DELAY_MS: "-1" }).maxRetryDelayMs, 60000);
  assert.equal(loadConfig({ ...env, MAX_RETRY_DELAY_MS: "abc" }).maxRetryDelayMs, 60000);
});
