import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { setLogStream } from "@roundtable/knight-core";
import { dataPaths, loadConfig } from "../src/config.js";

/** Run fn with log output captured; returns the parsed warn entries. */
function captureWarnings(fn: () => void): Array<Record<string, unknown>> {
  const lines: string[] = [];
  setLogStream(new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } }));
  try {
    fn();
  } finally {
    setLogStream(process.stdout);
  }
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e["level"] === "warn");
}

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
  assert.equal(c.drainTimeoutMs, 1_840_000);
  assert.equal(c.maxConcurrentTasks, 1);
  assert.equal(c.metricsPort, 3000);
  assert.equal(c.logLevel, "info");
  assert.equal(c.thinkingLevel, "off");
  assert.equal(c.activityContent, "preview");
  assert.equal(c.skillsDir, "/skills");
});

test("pi-knight config env overrides and required vars", () => {
  const c = loadConfig({ ...env, TASK_TIMEOUT_MS: "1000", METRICS_PORT: "9", ACTIVITY_CONTENT: "none", MAX_CONCURRENT_TASKS: "4" });
  assert.equal(c.drainTimeoutMs, 41_000);
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

test("data paths: unset KNIGHT_DATA_DIR keeps the /data layout", () => {
  assert.deepEqual(dataPaths({}), {
    dataDir: "/data",
    workRoot: "/data/work",
    sessionsRoot: "/data/sessions",
    modelsJson: "/data/models.json",
  });
  assert.equal(dataPaths({ KNIGHT_DATA_DIR: "" }).dataDir, "/data");
});

test("data paths: KNIGHT_DATA_DIR is the default root for work, sessions and models", () => {
  assert.deepEqual(dataPaths({ KNIGHT_DATA_DIR: "/tmp/k" }), {
    dataDir: "/tmp/k",
    workRoot: "/tmp/k/work",
    sessionsRoot: "/tmp/k/sessions",
    modelsJson: "/tmp/k/models.json",
  });
});

test("data paths: specific overrides take precedence over KNIGHT_DATA_DIR", () => {
  assert.deepEqual(
    dataPaths({
      KNIGHT_DATA_DIR: "/tmp/k",
      KNIGHT_WORK_ROOT: "/w",
      KNIGHT_SESSIONS_ROOT: "/s",
      MODELS_JSON_PATH: "/config/models.json",
    }),
    { dataDir: "/tmp/k", workRoot: "/w", sessionsRoot: "/s", modelsJson: "/config/models.json" },
  );
  // Empty MODELS_JSON_PATH falls back to the default, as before.
  assert.equal(dataPaths({ KNIGHT_DATA_DIR: "/tmp/k", MODELS_JSON_PATH: "" }).modelsJson, "/tmp/k/models.json");
});

test("data paths: empty KNIGHT_WORK_ROOT and KNIGHT_SESSIONS_ROOT fall back to the data root", () => {
  assert.deepEqual(dataPaths({ KNIGHT_DATA_DIR: "/d", KNIGHT_WORK_ROOT: "", KNIGHT_SESSIONS_ROOT: "" }), {
    dataDir: "/d",
    workRoot: "/d/work",
    sessionsRoot: "/d/sessions",
    modelsJson: "/d/models.json",
  });
  assert.equal(dataPaths({ KNIGHT_WORK_ROOT: "", KNIGHT_SESSIONS_ROOT: "" }).workRoot, "/data/work");
});

test("KNIGHT_THINKING: valid levels pass through without a warning", () => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    let cfg: ReturnType<typeof loadConfig> | undefined;
    const warnings = captureWarnings(() => {
      cfg = loadConfig({ ...env, KNIGHT_THINKING: level });
    });
    assert.equal(cfg?.thinkingLevel, level);
    assert.equal(warnings.length, 0);
  }
});

test("KNIGHT_THINKING: unset or empty is off without a warning", () => {
  for (const v of [undefined, ""]) {
    let cfg: ReturnType<typeof loadConfig> | undefined;
    const warnings = captureWarnings(() => {
      cfg = loadConfig({ ...env, KNIGHT_THINKING: v });
    });
    assert.equal(cfg?.thinkingLevel, "off");
    assert.equal(warnings.length, 0);
  }
});

test("KNIGHT_THINKING: a typo warns once, naming the variable and accepted values, and uses off", () => {
  let cfg: ReturnType<typeof loadConfig> | undefined;
  const warnings = captureWarnings(() => {
    cfg = loadConfig({ ...env, KNIGHT_THINKING: "hgih" });
  });
  assert.equal(cfg?.thinkingLevel, "off");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.["msg"]), /KNIGHT_THINKING/);
  assert.match(String(warnings[0]?.["msg"]), /off, minimal, low, medium, high, xhigh, max/);
  assert.equal(warnings[0]?.["value"], "hgih");
});

test("ACTIVITY_CONTENT: none and preview pass through; a typo warns and uses preview", () => {
  assert.equal(captureWarnings(() => loadConfig({ ...env, ACTIVITY_CONTENT: "none" })).length, 0);
  assert.equal(captureWarnings(() => loadConfig({ ...env, ACTIVITY_CONTENT: "preview" })).length, 0);
  let cfg: ReturnType<typeof loadConfig> | undefined;
  const warnings = captureWarnings(() => {
    cfg = loadConfig({ ...env, ACTIVITY_CONTENT: "nonne" });
  });
  assert.equal(cfg?.activityContent, "preview");
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.["msg"]), /ACTIVITY_CONTENT/);
});

test("pi-knight numeric env vars: garbage falls back to the default, never NaN", () => {
  const cases: Array<[string, keyof ReturnType<typeof loadConfig>, number]> = [
    ["MAX_CONCURRENT_TASKS", "maxConcurrentTasks", 1],
    ["MAX_RETRY_DELAY_MS", "maxRetryDelayMs", 60000],
    ["MODEL_REQUEST_TIMEOUT_MS", "modelRequestTimeoutMs", 600000],
    ["THINKING_BUDGET_LOW", "thinkingBudgetLow", 1024],
    ["THINKING_BUDGET_MEDIUM", "thinkingBudgetMedium", 4096],
    ["THINKING_BUDGET_HIGH", "thinkingBudgetHigh", 8192],
    ["SESSION_RETENTION_MAX_FILES", "sessionRetentionMaxFiles", 100],
    ["SESSION_RETENTION_DAYS", "sessionRetentionDays", 30],
    ["TASK_TIMEOUT_MS", "taskTimeoutMs", 1_800_000],
  ];
  for (const [name, field, def] of cases) {
    for (const v of ["abc", "NaN", ""]) {
      const got = loadConfig({ ...env, [name]: v })[field];
      assert.equal(got, def, `${name}=${JSON.stringify(v)}`);
      assert.ok(!Number.isNaN(got));
    }
  }
});
