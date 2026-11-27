import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, recordRefusal } from "../src/runtime-metrics.js";
import { refusalCode } from "../src/result-extraction.js";

// NaN when the series is missing, so a missing series can never compare equal to another NaN.
async function hits(): Promise<number> {
  const line = (await registry.metrics()).split("\n").find((l) => l.startsWith("roundtable_knight_usage_limit_hits_total"));
  if (!line) return NaN;
  return Number(line.split(" ").pop());
}

test("a credit refusal increments usage_limit_hits_total once; a normal failure does not", async () => {
  const before = await hits();
  assert.ok(Number.isFinite(before), "usage_limit_hits_total series must exist");
  recordRefusal(refusalCode("some ordinary failure"));
  const afterNormal = await hits();
  assert.ok(Number.isFinite(afterNormal), "usage_limit_hits_total series must exist");
  assert.equal(afterNormal, before);
  recordRefusal("credits");
  const afterCredit = await hits();
  assert.ok(Number.isFinite(afterCredit), "usage_limit_hits_total series must exist");
  assert.equal(afterCredit, before + 1);
});
