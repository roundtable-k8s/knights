import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contractSchemaFiles } from "../src/contract/export.ts";
import {
  activityEventErrors,
  assertTaskResult,
  invalidTaskResult,
  lostTaskResult,
  parseTask,
  taskPayloadErrors,
  taskResultErrors,
} from "../src/contract/index.ts";
import {
  ACTIVITY_FIXTURES,
  RESULT_FIXTURES,
  TASK_FIXTURES,
  readFixture,
  readFixtureText,
  resultFixtureDiff,
} from "../src/contract/fixtures.ts";

const CONTRACT_DIR = new URL("../contract/", import.meta.url);

// ── Stale-schema check: the committed JSON Schema must match the TypeBox source ──

test("committed contract/*.schema.json are up to date (run `npm run contract:export`)", () => {
  for (const [name, content] of Object.entries(contractSchemaFiles())) {
    let committed = "";
    try {
      committed = readFileSync(new URL(name, CONTRACT_DIR), "utf8");
    } catch {
      // reported below
    }
    assert.equal(committed, content, `packages/core/contract/${name} is stale: run \`npm run contract:export\``);
  }
});

// ── Golden fixtures ──

for (const name of TASK_FIXTURES) {
  test(`fixture ${name} is a valid TaskPayload`, () => {
    assert.deepEqual(taskPayloadErrors(readFixture(name)), []);
  });
}
for (const name of RESULT_FIXTURES) {
  test(`fixture ${name} is a valid TaskResult`, () => {
    assert.deepEqual(taskResultErrors(readFixture(name)), []);
    assert.deepEqual(resultFixtureDiff(readFixture(name), name), []);
  });
}
for (const name of ACTIVITY_FIXTURES) {
  test(`fixture ${name} is a valid ActivityEvent of its type`, () => {
    const ev = readFixture(name);
    assert.deepEqual(activityEventErrors(ev), []);
    assert.equal(`activity.${ev.type}`, name);
  });
}

test("task.minimal parses to just the id and prompt", () => {
  assert.deepEqual(parseTask(readFixtureText("task.minimal"), "subj"), {
    task: "Say hello.",
    taskId: "t-minimal",
    domain: undefined, from: undefined, dispatchedBy: undefined, timestamp: undefined, timeoutMs: undefined,
    runId: undefined, chainName: undefined, stepName: undefined, model: undefined, publishedAtMs: undefined,
    attempt: undefined, retryOf: undefined, previousFailure: undefined,
  });
});

test("task.full sets every ParsedTask field", () => {
  const p = parseTask(readFixtureText("task.full"), "subj");
  assert.equal(p.invalid, undefined);
  for (const k of ["task", "taskId", "domain", "from", "dispatchedBy", "timestamp", "timeoutMs", "runId", "chainName",
    "stepName", "model", "publishedAtMs", "attempt", "retryOf", "previousFailure"] as const) {
    assert.notEqual(p[k], undefined, k);
  }
  assert.equal(p.attempt, 2);
  assert.equal(p.timeoutMs, 1800000);
});

test("lostTaskResult matches result.lost", () => {
  const r = lostTaskResult({ taskId: "t-1", knight: "galahad", model: "claude-opus-5-5", timestamp: "2026-11-24T10:00:05.000Z" });
  assert.deepEqual(resultFixtureDiff(r, "result.lost"), []);
});

test("invalidTaskResult names the field and is a valid failure result", () => {
  const r = invalidTaskResult({ taskId: "t", knight: "k", model: "m", invalid: "runId: must be string" });
  assertTaskResult(r);
  assert.equal(r.success, false);
  assert.equal(r.error, "Invalid task payload: runId: must be string");
});

test("invalidTaskResult for an empty task is a valid failure result (#139)", () => {
  const r = invalidTaskResult({ taskId: "t", knight: "k", model: "m", invalid: "task: must not be empty" });
  assertTaskResult(r);
  assert.equal(r.success, false);
  assert.equal(r.error, "Invalid task payload: task: must not be empty");
});

test("resultFixtureDiff reports schema errors, missing, extra and changed fields", () => {
  const ok = readFixture("result.success");
  assert.deepEqual(resultFixtureDiff({ ...ok, tokens: { ...(ok.tokens as object), cacheRead: 9 } }, "result.success"), []);
  const { model: _m, ...noModel } = ok;
  assert.deepEqual(resultFixtureDiff({ ...noModel, refused: "quota", result: "x" }, "result.success"), [
    "schema: model: required",
    "result: \"x\" != \"Done.\"",
    "refused: not in result.success",
    "model: missing",
  ]);
});

test("TaskResult rejects an unknown refusal and accepts both known ones", () => {
  const base = readFixture("result.failure");
  assert.deepEqual(taskResultErrors({ ...base, refused: "credits" }), []);
  assert.deepEqual(taskResultErrors({ ...base, refused: "quota" }), []);
  assert.deepEqual(taskResultErrors({ ...base, refused: "money" }), ["refused: must be equal to one of the allowed values"]);
});

test("usage_limited is marked deprecated in the exported schema", () => {
  const schema = JSON.parse(contractSchemaFiles()["task-result.schema.json"]!);
  assert.equal(schema.properties.usage_limited.deprecated, true);
  assert.deepEqual(schema.properties.refused.enum, ["credits", "quota"]);
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
});

// ── Activity schema vs roundtable's hand-written docs/design/task-activity-events.schema.json ──
// tests/fixtures/roundtable-task-activity-events.schema.json is a copy of that file.

test("exported activity schema is equivalent to roundtable's hand-written one", () => {
  const ours = JSON.parse(contractSchemaFiles()["task-activity-events.schema.json"]!);
  const theirs = JSON.parse(readFileSync(new URL("./fixtures/roundtable-task-activity-events.schema.json", import.meta.url), "utf8"));
  for (const k of ["$schema", "$id", "title", "type", "additionalProperties"]) assert.deepEqual(ours[k], theirs[k], k);
  assert.deepEqual([...ours.required].sort(), [...theirs.required].sort());
  assert.deepEqual(ours.properties, theirs.properties);
});

test("transient fields validate and classify provider errors only", async () => {
  const { transientFailure } = await import("../src/contract/transient.ts");
  const base = JSON.parse(readFileSync(new URL("../contract/fixtures/result.transient.json", import.meta.url), "utf8"));
  assert.deepEqual(taskResultErrors(base), []);
  assert.notDeepEqual(taskResultErrors({ ...base, transientReason: "bogus" }), []);
  assert.equal(transientFailure("API Error: 529 Overloaded")?.transientReason, "overloaded");
  for (const c of ["500", "502", "503", "504"]) assert.equal(transientFailure(`HTTP ${c} Bad`)?.transientReason, "provider_5xx");
  assert.equal(transientFailure("connect ETIMEDOUT 1.2.3.4:443")?.transientReason, "network");
  assert.equal(transientFailure("API Error: Request timed out.")?.transientReason, "network");
  assert.equal(transientFailure("APIConnectionTimeoutError: Request timed out.")?.transientReason, "network");
  assert.equal(transientFailure("APIConnectionTimeoutError")?.transientReason, "network");
  assert.equal(transientFailure("Task timed out after 600s"), undefined);
  assert.equal(transientFailure("3 tests failed"), undefined);
});

// result.truncated is produced by publishResult (capResultText), not by a runtime's result builder,
// so it is not in RESULT_FIXTURES (the runtimes rebuild those from inputs).
test("fixture result.truncated is a valid TaskResult marked truncated", () => {
  const f = JSON.parse(readFileSync(new URL("../contract/fixtures/result.truncated.json", import.meta.url), "utf8"));
  assert.deepEqual(taskResultErrors(f), []);
  assert.equal(f.result_truncated, true);
});
