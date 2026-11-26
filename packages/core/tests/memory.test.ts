import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { dailyLogName, memoryPromptSection, migrateMemory, resolveMemoryPaths, setupMemory, writeFileAtomic } from "../src/memory.js";

const tmp = () => mkdtempSync(join(tmpdir(), "mem-"));

test("unset: paths are the /data layout and the prompt section is empty", () => {
  const p = resolveMemoryPaths({});
  assert.equal(p.longTermFile, "/data/MEMORY.md");
  assert.equal(p.dailyLogDir, "/data/memory");
  assert.equal(p.dailyLogPattern, "memory/YYYY-MM-DD.md");
  assert.equal(memoryPromptSection(p), "");
});

test("set: paths and prompt point at the memory dir, root line only with a root", () => {
  const p = resolveMemoryPaths({ memoryDir: "/memory/k", memoryRoot: "/memory" });
  assert.equal(p.longTermFile, "/memory/k/MEMORY.md");
  assert.equal(p.dailyLogDir, "/memory/k/memory");
  const text = memoryPromptSection(p);
  assert.match(text, /\/memory\/k\/MEMORY\.md/);
  assert.match(text, /Other knights' memory is under `\/memory\/<name>\/`; read it when useful, never write there\./);
  assert.doesNotMatch(memoryPromptSection(resolveMemoryPaths({ memoryDir: "/memory/k" })), /Other knights/);
});

test("daily log names include the hostname", () => {
  assert.equal(dailyLogName(new Date("2026-11-24T10:00:00Z"), "pod-1"), "2026-11-24-pod-1.md");
  assert.match(resolveMemoryPaths({ memoryDir: "/m" }).dailyLogPattern, new RegExp(`-${hostname()}\\.md$`));
});

test("migration copies once and never overwrites", () => {
  const data = tmp();
  const mem = join(tmp(), "k");
  writeFileSync(join(data, "MEMORY.md"), "old");
  mkdirSync(join(data, "memory"));
  writeFileSync(join(data, "memory", "2026-01-01.md"), "log");
  assert.equal(migrateMemory({ memoryDir: mem, dataDir: data }), true);
  assert.equal(readFileSync(join(mem, "MEMORY.md"), "utf8"), "old");
  assert.equal(readFileSync(join(mem, "memory", "2026-01-01.md"), "utf8"), "log");
  // second run: target exists, source changed — untouched
  writeFileSync(join(data, "MEMORY.md"), "newer");
  assert.equal(migrateMemory({ memoryDir: mem, dataDir: data }), false);
  assert.equal(readFileSync(join(mem, "MEMORY.md"), "utf8"), "old");
});

test("migration is a no-op without a memory dir or a source", () => {
  assert.equal(migrateMemory({ dataDir: tmp() }), false);
  assert.equal(migrateMemory({ memoryDir: join(tmp(), "k"), dataDir: tmp() }), false);
});

test("writeFileAtomic replaces the file and leaves no temp file", () => {
  const d = tmp();
  const f = join(d, "MEMORY.md");
  writeFileAtomic(f, "a");
  writeFileAtomic(f, "b");
  assert.equal(readFileSync(f, "utf8"), "b");
  assert.deepEqual(readdirSync(d), ["MEMORY.md"]);
  assert.ok(existsSync(f));
});

test("writeFileAtomic: a failure between write and rename leaves the previous file intact and no temp file", () => {
  const d = tmp();
  const f = join(d, "current.md");
  writeFileAtomic(f, "old");
  assert.throws(
    () =>
      writeFileAtomic(f, "new", {
        write: (p, data) => writeFileSync(p, data),
        rename: () => {
          throw new Error("crash before rename");
        },
      }),
    /crash before rename/,
  );
  assert.equal(readFileSync(f, "utf8"), "old");
  assert.deepEqual(readdirSync(d), ["current.md"]);
});

test("migration temp name is unique per call (pid is 1 in every pod)", () => {
  // a leftover temp from another replica (same pid) does not collide
  const data = tmp();
  const mem = join(tmp(), "k");
  mkdirSync(mem, { recursive: true });
  writeFileSync(join(data, "MEMORY.md"), "x");
  writeFileSync(join(mem, `MEMORY.md.${process.pid}.migrate.tmp`), "other replica");
  assert.equal(migrateMemory({ memoryDir: mem, dataDir: data }), true);
  assert.equal(readFileSync(join(mem, "MEMORY.md"), "utf8"), "x");
  assert.equal(readFileSync(join(mem, `MEMORY.md.${process.pid}.migrate.tmp`), "utf8"), "other replica");
  assert.deepEqual(readdirSync(mem).filter((f) => f.includes(hostname())), [], "own temp is renamed away");
});

test("setupMemory: success leaves the config alone", () => {
  const cfg: { memoryDir?: string; memoryRoot?: string } = { memoryDir: join(tmp(), "k"), memoryRoot: "/memory" };
  assert.equal(setupMemory(cfg, tmp(), () => assert.fail("no error expected")), null);
  assert.ok(cfg.memoryDir);
  assert.ok(existsSync(join(cfg.memoryDir!, "memory")));
});

test("setupMemory: an unusable volume is reported and falls back to /data paths", () => {
  const blocker = join(tmp(), "file");
  writeFileSync(blocker, "not a dir");
  const cfg: { memoryDir?: string; memoryRoot?: string } = { memoryDir: join(blocker, "k"), memoryRoot: "/memory" };
  const reasons: string[] = [];
  const data = tmp();
  const reason = setupMemory(cfg, data, (r) => reasons.push(r));
  assert.ok(reason);
  assert.deepEqual(reasons, [reason]);
  assert.equal(cfg.memoryDir, undefined);
  assert.equal(cfg.memoryRoot, undefined);
  assert.equal(resolveMemoryPaths({ ...cfg, dataDir: data }).longTermFile, join(data, "MEMORY.md"));
});
