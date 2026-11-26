import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitForSkills } from "../src/skills.ts";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "skillwait-"));
  const cfg = { skillsDir: join(root, "skills"), claudeConfigDir: join(root, "claude"), configDir: join(root, "config") };
  mkdirSync(cfg.skillsDir);
  mkdirSync(cfg.configDir);
  return { root, cfg };
}

test("empty KNIGHT_SKILLS in the custom config dir: no sleep, one pass", async () => {
  const { root, cfg } = setup();
  const saved = process.env["KNIGHT_SKILLS"];
  delete process.env["KNIGHT_SKILLS"];
  try {
    writeFileSync(join(cfg.configDir, "KNIGHT_SKILLS"), "");
    const sleeps: number[] = [];
    const n = await waitForSkills(cfg, { sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(n, 0);
    assert.deepEqual(sleeps, []);
  } finally {
    if (saved !== undefined) process.env["KNIGHT_SKILLS"] = saved;
    rmSync(root, { recursive: true, force: true });
  }
});

test("expected but none appear: polls with sleeps", async () => {
  const { root, cfg } = setup();
  try {
    const sleeps: number[] = [];
    const n = await waitForSkills(cfg, { expected: true, sleep: async (ms) => { sleeps.push(ms); } });
    assert.equal(n, 0);
    assert.equal(sleeps.length, 19);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("expected and a skill present: returns immediately", async () => {
  const { root, cfg } = setup();
  try {
    mkdirSync(join(cfg.skillsDir, "shared", "s1"), { recursive: true });
    writeFileSync(join(cfg.skillsDir, "shared", "s1", "SKILL.md"), "x");
    const n = await waitForSkills(cfg, { expected: true, sleep: async () => { throw new Error("slept"); } });
    assert.equal(n, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
