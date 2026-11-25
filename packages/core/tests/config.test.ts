import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBaseConfig, maxConcurrentTasks, parseTopics, positiveIntEnv, floatEnv } from "../src/config.js";

test("loadBaseConfig applies defaults", () => {
  assert.deepEqual(loadBaseConfig({ KNIGHT_NAME: "k" }), {
    knightName: "k",
    table: "none",
    natsUrl: "nats://nats.database.svc.cluster.local:4222",
    natsResultsPrefix: "fleet-a.results",
    resultPublishRetryMs: 60_000,
    resultMaxBytes: 512 * 1024,
    metricsPort: 3000,
    logLevel: "info",
    taskTimeoutMs: 1_800_000,
    drainTimeoutMs: 1_860_000,
  });
});

test("loadBaseConfig reads env overrides", () => {
  const c = loadBaseConfig({
    KNIGHT_NAME: "k",
    NATS_URL: "nats://x:4222",
    NATS_RESULTS_PREFIX: "p.results",
    METRICS_PORT: "9000",
    LOG_LEVEL: "debug",
    TASK_TIMEOUT_MS: "1000",
  });
  assert.equal(c.natsUrl, "nats://x:4222");
  assert.equal(c.natsResultsPrefix, "p.results");
  assert.equal(c.metricsPort, 9000);
  assert.equal(c.logLevel, "debug");
  assert.equal(c.taskTimeoutMs, 1000);
  assert.equal(c.drainTimeoutMs, 61_000);
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", TASK_TIMEOUT_MS: "1000", DRAIN_TIMEOUT_MS: "5" }).drainTimeoutMs, 5);
});

test("loadBaseConfig requires KNIGHT_NAME and ignores unparsable numbers", () => {
  assert.throws(() => loadBaseConfig({}), /KNIGHT_NAME/);
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", METRICS_PORT: "abc" }).metricsPort, 3000);
});

test("loadBaseConfig reads the optional memory env vars", () => {
  const c = loadBaseConfig({ KNIGHT_NAME: "k", KNIGHT_MEMORY_DIR: "/memory/k", KNIGHT_MEMORY_ROOT: "/memory" });
  assert.equal(c.memoryDir, "/memory/k");
  assert.equal(c.memoryRoot, "/memory");
});

test("loadBaseConfig reads ROUNDTABLE_TABLE, none when empty", () => {
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", ROUNDTABLE_TABLE: "dev" }).table, "dev");
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", ROUNDTABLE_TABLE: "" }).table, "none");
});


test("maxConcurrentTasks never returns NaN, 0 or negatives", () => {
  for (const v of ["abc", "0", "-3", "1.5"]) assert.equal(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: v }, 2), 1);
  assert.equal(maxConcurrentTasks({}, 2), 2);
  assert.equal(maxConcurrentTasks({ MAX_CONCURRENT_TASKS: "4" }, 2), 4);
});

test("parseTopics trims and drops empty entries", () => {
  assert.deepEqual(parseTopics("a, ,b,"), ["a", "b"]);
});

test("positiveIntEnv falls back on bad or below-minimum values", () => {
  assert.equal(positiveIntEnv({ X: "abc" }, "X", 7), 7);
  assert.equal(positiveIntEnv({ X: "0" }, "X", 7), 7);
  assert.equal(positiveIntEnv({ X: "0" }, "X", 7, { min: 0 }), 0);
  assert.equal(positiveIntEnv({ X: "5" }, "X", 7), 5);
});

test("floatEnv parses or falls back", () => {
  assert.equal(floatEnv({ X: "0.5" }, "X", 1), 0.5);
  assert.equal(floatEnv({ X: "nope" }, "X", 1), 1);
});

test("loadBaseConfig rejects non-positive timeouts", () => {
  const c = loadBaseConfig({ KNIGHT_NAME: "k", TASK_TIMEOUT_MS: "0", DRAIN_TIMEOUT_MS: "-5" });
  assert.equal(c.taskTimeoutMs, 1_800_000);
  assert.equal(c.drainTimeoutMs, 1_860_000);
});

test("loadBaseConfig reads RESULT_PUBLISH_RETRY_MS (default 60 s, 0 disables retries)", () => {
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k" }).resultPublishRetryMs, 60_000);
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", RESULT_PUBLISH_RETRY_MS: "5000" }).resultPublishRetryMs, 5000);
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", RESULT_PUBLISH_RETRY_MS: "0" }).resultPublishRetryMs, 0);
  assert.equal(loadBaseConfig({ KNIGHT_NAME: "k", RESULT_PUBLISH_RETRY_MS: "x" }).resultPublishRetryMs, 60_000);
});
