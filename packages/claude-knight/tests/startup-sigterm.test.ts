/**
 * Process-level: the real knight process gets SIGTERM while it waits for skills
 * (before it connects to NATS). It must exit 0 within a few seconds and never
 * connect or subscribe. Before the start-up handlers existed the signal was
 * either dropped (PID 1 in a pod) or killed the process without cleanup.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The child runs the compiled dist/, built once here: spawning `tsx src/index.ts` cold-compiles the whole
// import graph, which exceeded the budget under a parallel `npm test`. The budgets are also generous on purpose.
const PKG = resolve(import.meta.dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

function buildDist() {
  const tsc = resolve(PKG, "../../node_modules/typescript/bin/tsc");
  const outDir = join(PKG, "dist"); // inside the package so @roundtable/knight-core resolves from node_modules (gitignored)
  const r = spawnSync(process.execPath, [tsc, "-p", PKG, "--outDir", outDir, "--incremental", "false"], { cwd: PKG, encoding: "utf8" });
  return { outDir, r };
}

test("SIGTERM during the skills wait: exits 0 within seconds, never connects to NATS or subscribes", async () => {
  const { outDir, r: build } = buildDist();
  assert.equal(build.status, 0, `tsc build failed:\n${build.stdout}${build.stderr}`);
  assert.ok(existsSync(join(outDir, "index.js")), `tsc produced no index.js:\n${build.stdout}${build.stderr}`);
  const home = mkdtempSync(join(tmpdir(), "ck-startup-"));
  const work = join(home, "data");
  mkdirSync(work);
  mkdirSync(join(home, "skills")); // empty: the knight waits for git-sync
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    KNIGHT_NAME: "Startup",
    SUBSCRIBE_TOPICS: "rt.tasks.test.>",
    KNIGHT_WORKDIR: work,
    KNIGHT_SKILLS_DIR: join(home, "skills"),
    KNIGHT_CONFIG_DIR: join(home, "config"),
    CLAUDE_AUTH_MODE: "api",
    ANTHROPIC_API_KEY: "sk-ant-api03-fake-startup",
    METRICS_PORT: String(await freePort()),
    NATS_URL: "nats://127.0.0.1:1",
  };
  const child = spawn(process.execPath, [join(outDir, "index.js")], { cwd: PKG, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  try {
    const deadline = Date.now() + 60_000;
    while (!out.includes("waiting for git-sync") && Date.now() < deadline && child.exitCode === null) await sleep(50);
    assert.match(out, /waiting for git-sync/, out);

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
    assert.doesNotMatch(out, /Connecting to NATS|Claude-Knight ready/);
  } finally {
    child.kill("SIGKILL");
    rmSync(home, { recursive: true, force: true });
  }
});
