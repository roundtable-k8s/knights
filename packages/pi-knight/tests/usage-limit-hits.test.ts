import { test } from "node:test";
import assert from "node:assert/strict";
import { registry, recordRefusal } from "../src/runtime-metrics.js";
import { refusalCode } from "../src/result-extraction.js";

async function hits(): Promise<number> {
  const line = (await registry.metrics()).split("\n").find((l) => l.startsWith("roundtable_knight_usage_limit_hits_total"));
  return Number(line?.split(" ").pop());
}

test("a credit refusal increments usage_limit_hits_total once; a normal failure does not", async () => {
  const before = await hits();
  recordRefusal(refusalCode("some ordinary failure"));
  assert.equal(await hits(), before);
  recordRefusal("credits");
  assert.equal(await hits(), before + 1);
});
