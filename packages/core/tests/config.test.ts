import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBaseConfig } from "../src/config.js";

test("loadBaseConfig applies defaults", () => {
  assert.deepEqual(loadBaseConfig({ KNIGHT_NAME: "k" }), {
    knightName: "k",
    table: "none",
    natsUrl: "nats://nats.database.svc.cluster.local:4222",
    natsResultsPrefix: "fleet-a.results",
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
