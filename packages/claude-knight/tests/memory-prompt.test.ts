import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreamble } from "../src/prompt.js";
import { loadConfig } from "../src/config.js";

const base = { KNIGHT_NAME: "Kay", SUBSCRIBE_TOPICS: "x" };

test("memory dir unset: prompt has no memory layout section", () => {
  assert.doesNotMatch(buildPreamble(loadConfig(base)), /memory_layout/);
});

test("memory dir set: prompt points at the memory volume", () => {
  const p = buildPreamble(loadConfig({ ...base, KNIGHT_MEMORY_DIR: "/memory/Kay", KNIGHT_MEMORY_ROOT: "/memory" }));
  assert.match(p, /\/memory\/Kay\/MEMORY\.md/);
  assert.match(p, /never write there/);
});
