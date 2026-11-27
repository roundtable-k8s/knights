/**
 * Process-level: the real knight process gets SIGTERM while it waits for skills
 * (before it connects to NATS). It must exit 0 within a few seconds and never
 * connect or subscribe. Before the start-up handlers existed the signal was
 * either dropped (PID 1 in a pod) or killed the process without cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

test("SIGTERM during the skills wait: exits 0 within seconds, never connects to NATS or subscribes", { timeout: 180_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pk-startup-"));
  const work = join(home, "data");
  mkdirSync(work);
  mkdirSync(join(home, "skills")); // empty: the knight waits for git-sync
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    KNIGHT_NAME: "Startup",
    SUBSCRIBE_TOPICS: "rt.tasks.test.>",
    KNIGHT_DATA_DIR: work,
    KNIGHT_SKILLS: "x", // a skill category is configured, so the skills wait runs
    KNIGHT_SKILLS_DIR: join(home, "skills"),
    KNIGHT_MODEL: "openrouter/deepseek/deepseek-v3.2", // cloud model: preflight is a no-op
    OPENROUTER_API_KEY: "sk-or-fake-startup",
    METRICS_PORT: String(await freePort()),
    NATS_URL: "nats://127.0.0.1:1",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  try {
    // tsx compiles the whole tree on first run; wait on the readiness line, bounded only by the
    // test's own timeout, and stop early if the child dies.
    while (!out.includes("No skills found, waiting for git-sync") && child.exitCode === null) await sleep(50);
    assert.match(out, /No skills found, waiting for git-sync/, out);

    const sentAt = Date.now();
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const { code, signal } = await exited;
    clearTimeout(killer);
    const elapsed = Date.now() - sentAt;

    assert.equal(signal, null, `killed by ${signal}, not a clean exit:\n${out}`);
    assert.equal(code, 0, out);
    assert.ok(elapsed < 5000, `took ${elapsed}ms`);
    assert.match(out, /Shutdown signal received during start-up/);
    assert.doesNotMatch(out, /Connecting to NATS|Pi-Knight ready|Task received/);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});

test("scrubAgentEnv runs at start-up: a production-mode switch is gone before the first signal handler runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "pk-scrub-"));
  const work = join(home, "data");
  mkdirSync(work);
  mkdirSync(join(home, "skills"));
  // Preloaded: registers its SIGTERM listener before the app's, so it reports the env the app left in place.
  const probe = join(home, "probe.mjs");
  writeFileSync(probe, `process.on("SIGTERM", () => console.log("PROBE NODE_ENV=" + process.env.NODE_ENV + " OMIT=" + process.env.npm_config_omit));\n`);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    NODE_ENV: "production",
    npm_config_omit: "dev",
    KNIGHT_NAME: "Scrub",
    SUBSCRIBE_TOPICS: "rt.tasks.test.>",
    KNIGHT_DATA_DIR: work,
    KNIGHT_SKILLS: "x",
    KNIGHT_SKILLS_DIR: join(home, "skills"),
    KNIGHT_MODEL: "openrouter/deepseek/deepseek-v3.2",
    OPENROUTER_API_KEY: "sk-or-fake-startup",
    METRICS_PORT: String(await freePort()),
    NATS_URL: "nats://127.0.0.1:1",
  };
  const child = spawn(process.execPath, ["--import", "tsx", "--import", probe, "src/index.ts"], { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<void>((r) => child.on("exit", () => r()));
  try {
    const deadline = Date.now() + 90_000;
    while (!out.includes("No skills found, waiting for git-sync") && Date.now() < deadline && child.exitCode === null) await sleep(50);
    assert.match(out, /No skills found, waiting for git-sync/, out);
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    await exited;
    clearTimeout(killer);
    assert.match(out, /PROBE NODE_ENV=undefined OMIT=undefined/, out);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
