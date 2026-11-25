import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
