/**
 * The "Run a knight locally" README flow, end to end: scripts/dev/nats-up.sh starts a
 * nats-server with the streams and consumer, the knight runs with the fake Claude binary
 * (no credentials, no /data), and scripts/dev/send-task.ts gets its success result.
 * Skipped without a nats-server on PATH or in NATS_SERVER_BIN.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(import.meta.dirname, "..");
const ROOT = resolve(PKG, "../..");

const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";
function hasBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env["PATH"] ?? "").split(":").some((d) => existsSync(join(d, bin)));
}
const skip = !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise<number>((done) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => done(port));
    });
  });

interface Proc {
  child: ChildProcess;
  out: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Proc {
  const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return { child, out: () => out, exited };
}

async function waitFor(p: Proc, re: RegExp, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!re.test(p.out()) && Date.now() < deadline && p.child.exitCode === null) await sleep(50);
  assert.match(p.out(), re, p.out());
}

async function stop(p: Proc | undefined): Promise<void> {
  if (!p || p.child.exitCode !== null || p.child.signalCode !== null) return;
  p.child.kill("SIGTERM");
  const killer = setTimeout(() => p.child.kill("SIGKILL"), 10_000);
  await p.exited;
  clearTimeout(killer);
}

test("README flow: nats-up.sh, claude-knight with the fake Claude binary, send-task gets a success result", { skip, timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "ck-local-dev-"));
  const work = join(home, "data");
  mkdirSync(work);
  const natsPort = await freePort();
  const natsUrl = `nats://127.0.0.1:${natsPort}`;
  // A clean environment: nothing from a knight env the developer (or a knight pod) may have.
  const base = { PATH: process.env.PATH, HOME: home, TMPDIR: home };
  let nats: Proc | undefined;
  let knight: Proc | undefined;
  try {
    nats = start("bash", [join(ROOT, "scripts/dev/nats-up.sh")], ROOT, {
      ...base,
      NATS_PORT: String(natsPort),
      NATS_SERVER_BIN: NATS_BIN,
      KNIGHT_NAME: "dev",
    });
    await waitFor(nats, /nats-up: ready/, 60_000);
    assert.match(nats.out(), /consumer dev-consumer on fleet-a\.tasks\.dev\.>/);

    knight = start(process.execPath, ["--import", "tsx", "src/index.ts"], PKG, {
      ...base,
      KNIGHT_NAME: "dev",
      SUBSCRIBE_TOPICS: "fleet-a.tasks.dev.>",
      NATS_URL: natsUrl,
      KNIGHT_WORKDIR: work,
      KNIGHT_SKILLS_DIR: join(ROOT, "scripts/dev/skills"),
      KNIGHT_CONFIG_DIR: join(home, "config"),
      METRICS_PORT: String(await freePort()),
      CLAUDE_AUTH_MODE: "api",
      ANTHROPIC_API_KEY: "fake",
      CLAUDE_RUNTIME: "cli",
      CLAUDE_BIN: join(PKG, "tests/helpers/fake-claude.mjs"),
      FAKE_CLAUDE_FIXTURE: join(PKG, "tests/fixtures/stream/success.jsonl"),
    });
    await waitFor(knight, /Claude-Knight ready/, 60_000);
    // Bound to the consumer nats-up created, not the 2-minute fallback.
    assert.match(knight.out(), /Bound to operator-owned consumer/);

    const send = start(process.execPath, ["--import", "tsx", "scripts/dev/send-task.ts", "Say hello.", "--knight", "dev", "--url", natsUrl, "--timeout", "30"], ROOT, base);
    const { code } = await send.exited;
    assert.equal(code, 0, `send-task:\n${send.out()}\nknight:\n${knight.out()}`);
    const result = JSON.parse(send.out().slice(send.out().indexOf("{")));
    assert.equal(result.success, true);
    assert.equal(result.knight, "dev");
    assert.equal(result.result, "pong");
    assert.match(result.task_id, /^dev-/);
  } finally {
    await stop(knight);
    await stop(nats);
    rmSync(home, { recursive: true, force: true });
  }
});
