import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionNotes } from "../src/memory.ts";
import { Writable } from "node:stream";
import { initLogger, setLogStream } from "@roundtable/knight-core";

function setup(): string {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  process.env["KNIGHT_DATA_DIR"] = dir;
  return join(dir, "session-notes");
}

test("twenty concurrent updateSessionNotes calls keep all twenty entries", async () => {
  const notesDir = setup();
  await Promise.all(Array.from({ length: 20 }, (_, i) => updateSessionNotes("k", `task-${i}`, `result-${i}`)));
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  for (let i = 0; i < 20; i++) assert.match(text, new RegExp(`- \\S+: task-${i} →`));
  assert.deepEqual(readdirSync(notesDir), ["current.md"]);
});

test("a failure between write and rename leaves the previous notes intact and does not block later updates", async () => {
  const notesDir = setup();
  await updateSessionNotes("k", "first", "r1");
  const before = readFileSync(join(notesDir, "current.md"), "utf8");
  const { writeFileSync } = await import("node:fs");
  await assert.rejects(
    updateSessionNotes("k", "second", "r2", {
      write: (p, d) => writeFileSync(p, d),
      rename: () => {
        throw new Error("crash");
      },
    }),
    /crash/,
  );
  assert.equal(readFileSync(join(notesDir, "current.md"), "utf8"), before);
  assert.deepEqual(readdirSync(notesDir), ["current.md"]);
  await updateSessionNotes("k", "third", "r3");
  assert.match(readFileSync(join(notesDir, "current.md"), "utf8"), /third/);
});

test("lookalike heading lines in task text and results do not displace the real sections across rewrites", async () => {
  const notesDir = setup();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    join(notesDir, "current.md"),
    [
      "# Current State",
      "_Knight: k_",
      "",
      "# Task Specification",
      "old task",
      "",
      "# Files and Functions",
      "_Updated by knight during task execution — check daily logs for details._",
      "",
      "# Errors & Corrections",
      "- real error",
      "",
      "# Learnings",
      "- real lesson",
      "",
      "# Key Results",
      "old result",
      "",
      "# Worklog",
      "- 2026-01-01T00:00:00.000Z: seed → result (3 chars)",
      "",
    ].join("\n"),
  );
  const task = "Refactor the parser\n# Learnings\n- fake lesson\n# Worklog\n- fake entry\n# Errors & Corrections\n- fake error";
  const result = "Done\n# Learnings\n- fake lesson in result\n# Key Results\nfake";
  await updateSessionNotes("k", task, result);
  await updateSessionNotes("k", task, result);
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  assert.match(text, /# Errors & Corrections\n- real error\n\n# Learnings\n- real lesson\n\n# Key Results\n/);
  assert.match(
    text,
    /# Worklog\n- 2026-01-01T00:00:00\.000Z: seed → result \(3 chars\)\n- \S+: Refactor the parser → result \(\d+ chars\)\n- \S+: Refactor the parser → result \(\d+ chars\)\n$/,
  );
  assert.doesNotMatch(text, /^# Worklog\n(?:- .*\n)*- fake entry/m);
});

test("free text starting with # is escaped so it is never read back as a heading", async () => {
  const notesDir = setup();
  await updateSessionNotes("k", "# Learnings\nbody", "# Worklog\nresult");
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  assert.match(text, /^\\# Learnings$/m);
  assert.match(text, /^\\# Worklog$/m);
  assert.equal(text.match(/^# Learnings$/gm)?.length, 1);
  assert.equal(text.match(/^# Worklog$/gm)?.length, 1);
});

test("notes without a section yield the empty placeholder for it", async () => {
  const notesDir = setup();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(join(notesDir, "current.md"), "# Current State\nno other sections here\n");
  await updateSessionNotes("k", "task", "result");
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  assert.match(text, /# Errors & Corrections\n_None recorded yet._/);
  assert.match(text, /# Learnings\n_None recorded yet._/);
});

test("setupCompactionHook counts compactions and retry sequences", async () => {
  const { setupCompactionHook } = await import("../src/memory.ts");
  const { registry } = await import("../src/runtime-metrics.ts");
  let listener: (e: any) => void = () => {};
  setupCompactionHook({ subscribe: (l: any) => { listener = l; return () => {}; } } as any, { knightName: "k" } as any);
  const value = async (name: string, labels: Record<string, string>) =>
    (await registry.getMetricsAsJSON()).find((m) => m.name === name)?.values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
  listener({ type: "compaction_start", reason: "threshold" });
  listener({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
  listener({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false });
  listener({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "boom sk-ant-api03-" + "a".repeat(40) });
  listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "e" });
  listener({ type: "auto_retry_end", success: true, attempt: 1 });
  listener({ type: "auto_retry_end", success: false, attempt: 3, finalError: "e" });
  assert.equal(await value("roundtable_knight_compactions_total", { reason: "threshold", outcome: "completed" }), 1);
  assert.equal(await value("roundtable_knight_compactions_total", { reason: "overflow", outcome: "aborted" }), 1);
  assert.equal(await value("roundtable_knight_compactions_total", { reason: "overflow", outcome: "failed" }), 1);
  assert.equal(await value("roundtable_knight_llm_retries_total", { outcome: "succeeded" }), 1);
  assert.equal(await value("roundtable_knight_llm_retries_total", { outcome: "exhausted" }), 1);
});

test("a legacy file with an unescaped # Worklog inside Key Results keeps its real Worklog", async () => {
  const notesDir = setup();
  mkdirSync(notesDir, { recursive: true });
  writeFileSync(
    join(notesDir, "current.md"),
    "# Current State\nx\n\n# Key Results\nold\n# Worklog\nfake\n\n# Worklog\n- 2026-01-01T00:00:00.000Z: first → result (1 chars)\n",
  );
  await updateSessionNotes("k", "second", "r");
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  assert.match(text, /- 2026-01-01T00:00:00.000Z: first →/);
  assert.match(text, /- \S+: second →/);
});

test("a task starting with # reads unescaped in the Worklog entry and the real Worklog survives", async () => {
  const notesDir = setup();
  await updateSessionNotes("k", "# Fix\nmore", "r");
  await updateSessionNotes("k", "next", "r");
  const text = readFileSync(join(notesDir, "current.md"), "utf8");
  assert.match(text, /^- \S+: # Fix → result/m);
  assert.doesNotMatch(text, /^- .*\\#/m);
  assert.match(text, /- \S+: next →/);
});

test("stale .tmp files in the notes dir are swept, fresh ones are left", async () => {
  const notesDir = setup();
  mkdirSync(notesDir, { recursive: true });
  const old = join(notesDir, "current.md.1.2.abc.tmp");
  const fresh = join(notesDir, "current.md.3.4.def.tmp");
  writeFileSync(old, "x");
  writeFileSync(fresh, "x");
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(old, past, past);
  await updateSessionNotes("k", "t", "r");
  assert.deepEqual(readdirSync(notesDir).sort(), ["current.md", "current.md.3.4.def.tmp"]);
});

test("stale .tmp files are swept once per process, not on every notes update", async () => {
  const notesDir = setup();
  mkdirSync(notesDir, { recursive: true });
  const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const first = join(notesDir, "current.md.1.1.aaa.tmp");
  writeFileSync(first, "x");
  utimesSync(first, past, past);
  await updateSessionNotes("k", "t1", "r1");
  assert.ok(!existsSync(first), "first update sweeps the stale leftover");

  const second = join(notesDir, "current.md.2.2.bbb.tmp");
  writeFileSync(second, "x");
  utimesSync(second, past, past);
  await updateSessionNotes("k", "t2", "r2");
  assert.ok(existsSync(second), "a later update in the same process does not sweep again");
});

test("a failed compaction logs a warn with the redacted error and never counts as completed", async () => {
  const { setupCompactionHook } = await import("../src/memory.ts");
  const { registry } = await import("../src/runtime-metrics.ts");
  const chunks: string[] = [];
  setLogStream(new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } }));
  initLogger("k", "info");
  try {
    const secret = "sk-ant-api03-" + "b".repeat(40);
    let listener: (e: any) => void = () => {};
    setupCompactionHook({ subscribe: (l: any) => { listener = l; return () => {}; } } as any, { knightName: "k" } as any);
    const value = async (labels: Record<string, string>) =>
      (await registry.getMetricsAsJSON()).find((m) => m.name === "roundtable_knight_compactions_total")?.values.find((v) => Object.entries(labels).every(([k, x]) => v.labels[k] === x))?.value ?? 0;
    const before = await value({ reason: "overflow", outcome: "completed" });
    listener({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: `summarisation boom ${secret}` });
    const lines = chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entry = lines.find((l) => l.msg === "Context compaction failed");
    assert.ok(entry, "warn logged");
    assert.equal(entry.level, "warn");
    assert.match(entry.error, /summarisation boom/);
    assert.ok(!entry.error.includes(secret), "token redacted");
    assert.ok(!chunks.join("").includes(secret));
    assert.equal(await value({ reason: "overflow", outcome: "completed" }), before);
    assert.equal(await value({ reason: "overflow", outcome: "failed" }) >= 1, true);
  } finally {
    // Always restore the real log stream, even when an assertion above throws.
    setLogStream(process.stdout);
    initLogger("k", "info");
  }
});
