import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Ask git, not the text of .gitignore: the Nix `result` symlinks at the package root must be ignored,
// and source files that merely share the prefix (tests/result-*.test.ts) must not be.
const pkgDir = fileURLToPath(new URL("..", import.meta.url));
const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: pkgDir, encoding: "utf8" });
const skip = probe.error ? "git is not on PATH" : probe.status !== 0 ? "package is not inside a git work tree" : false;

// `git check-ignore -q` exits 0 when the path is ignored and 1 when it is not.
const ignored = (path: string) => spawnSync("git", ["check-ignore", "-q", path], { cwd: pkgDir }).status === 0;

test("claude-knight .gitignore ignores the Nix result symlinks at the package root only", { skip }, () => {
  assert.ok(ignored("result"), "result is not ignored");
  assert.ok(ignored("result-1"), "result-1 is not ignored");
  assert.ok(!ignored("tests/result-contract.test.ts"), "tests/result-contract.test.ts is ignored");
});
