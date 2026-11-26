import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// The Nix `result` symlinks live at the package root only. Unanchored patterns would also hide
// source files such as tests/result-*.test.ts from `git add`.
test("claude-knight .gitignore anchors the Nix result symlinks to the package root", () => {
  const lines = readFileSync(new URL("../.gitignore", import.meta.url), "utf8")
    .split("\n")
    .map((l) => l.trim());
  assert.ok(lines.includes("/result"), "missing /result");
  assert.ok(lines.includes("/result-*"), "missing /result-*");
  assert.ok(!lines.includes("result"), "unanchored result pattern");
  assert.ok(!lines.includes("result-*"), "unanchored result-* pattern");
});
