import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSessionNotes } from "../src/memory.ts";

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
