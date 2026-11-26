import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/config.js";
import { sweepStaleWorkDirs } from "../src/knight.js";

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
