import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKnightPreamble } from "../src/knight.ts";
import { loadConfig } from "../src/config.ts";

process.env["KNIGHT_DATA_DIR"] = mkdtempSync(join(tmpdir(), "pk-memory-prompt-"));
const base = { KNIGHT_NAME: "Kay", SUBSCRIBE_TOPICS: "x" };

test("memory dir unset: prompt has no memory layout section", () => {
  assert.doesNotMatch(buildKnightPreamble(loadConfig(base)), /memory_layout/);
});

test("memory dir set: prompt points at the memory volume", () => {
  const p = buildKnightPreamble(loadConfig({ ...base, KNIGHT_MEMORY_DIR: "/memory/Kay", KNIGHT_MEMORY_ROOT: "/memory" }));
  assert.match(p, /\/memory\/Kay\/MEMORY\.md/);
  assert.match(p, /never write there/);
});
