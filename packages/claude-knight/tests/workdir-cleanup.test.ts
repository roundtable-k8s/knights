import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { forceRemoveTree, sweepStaleWorkDirs } from "../src/knight.js";

function readonlyTree(base: string): string {
  const bin = join(base, "rt", "bin", "k8s", "1.35.0-linux-amd64");
  mkdirSync(bin, { recursive: true });
  const etcd = join(bin, "etcd");
  writeFileSync(etcd, "x");
  chmodSync(etcd, 0o555);
  chmodSync(bin, 0o555);
  chmodSync(join(base, "rt", "bin", "k8s"), 0o555);
  return base;
}

test("forceRemoveTree removes nested read-only dirs and files", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-rm-"));
  const dir = readonlyTree(join(root, "task"));
  await forceRemoveTree(dir);
  assert.equal(existsSync(dir), false);
  rmSync(root, { recursive: true, force: true });
});

test("forceRemoveTree leaves symlink targets intact and unchmodded", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-rm-"));
  const protectedDir = join(root, ".claude");
  const protectedFile = join(root, "CLAUDE.md");
  mkdirSync(protectedDir);
  writeFileSync(join(protectedDir, "settings.json"), "{}");
  writeFileSync(protectedFile, "hi");
  chmodSync(protectedDir, 0o555);
  chmodSync(protectedFile, 0o444);
  const dir = readonlyTree(join(root, "task"));
  symlinkSync(protectedDir, join(dir, ".claude"));
  symlinkSync(protectedFile, join(dir, "CLAUDE.md"));

  await forceRemoveTree(dir);

  assert.equal(existsSync(dir), false);
  assert.equal(statSync(protectedDir).mode & 0o777, 0o555);
  assert.equal(statSync(protectedFile).mode & 0o777, 0o444);
  assert.equal(existsSync(join(protectedDir, "settings.json")), true);
  assert.equal(lstatSync(protectedFile).isFile(), true);
  chmodSync(protectedDir, 0o755);
  rmSync(root, { recursive: true, force: true });
});

test("sweepStaleWorkDirs removes only old dirs", async () => {
  const root = mkdtempSync(join(tmpdir(), "ck-sweep-"));
  const config = loadConfig({ KNIGHT_NAME: "Gawain", SUBSCRIBE_TOPICS: "rt.tasks.x.>", KNIGHT_WORKDIR: root });
  const work = join(root, "work");
  const old = readonlyTree(join(work, "old"));
  mkdirSync(join(work, "fresh"), { recursive: true });
  const past = new Date(Date.now() - 48 * 3600 * 1000);
  utimesSync(old, past, past);

  assert.equal(await sweepStaleWorkDirs(config), 1);
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(join(work, "fresh")), true);
  rmSync(root, { recursive: true, force: true });
});

test("forceRemoveTree does not block the event loop while it removes a big tree (#75)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ck-big-"));
  for (let i = 0; i < 40; i++) {
    const sub = join(dir, `d${i}`);
    mkdirSync(sub);
    for (let j = 0; j < 50; j++) writeFileSync(join(sub, `f${j}`), "x");
  }
  let ticks = 0;
  const t = setInterval(() => ticks++, 0);
  await forceRemoveTree(dir);
  clearInterval(t);
  assert.equal(existsSync(dir), false);
  assert.ok(ticks > 0, "timers (task heartbeats) still ran during the removal");
});
