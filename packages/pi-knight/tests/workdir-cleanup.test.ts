import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sweepStaleDirs } from "@roundtable/knight-core";
import { removeWorkDir } from "../src/knight.ts";

function readonlyTree(base: string): string {
  const bin = join(base, "pkg", "mod", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "etcd"), "x");
  chmodSync(join(bin, "etcd"), 0o555);
  chmodSync(bin, 0o555);
  chmodSync(join(base, "pkg", "mod"), 0o555);
  return base;
}

test("removeWorkDir removes a workspace holding read-only directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "pk-rm-"));
  const dir = readonlyTree(join(root, "run-x-1234"));
  await removeWorkDir(dir);
  assert.equal(existsSync(dir), false);
  rmSync(root, { recursive: true, force: true });
});

test("start-up sweep removes an old workspace, keeps a recent one and .warm", async () => {
  const work = mkdtempSync(join(tmpdir(), "pk-sweep-"));
  const old = readonlyTree(join(work, "run-old-1"));
  mkdirSync(join(work, "run-new-2"));
  mkdirSync(join(work, ".warm"));
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(old, past, past);
  utimesSync(join(work, ".warm"), past, past);

  assert.equal(await sweepStaleDirs(work, { skip: [".warm"] }), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(join(work, "run-new-2")), true);
  assert.equal(existsSync(join(work, ".warm")), true);
  rmSync(work, { recursive: true, force: true });
});
