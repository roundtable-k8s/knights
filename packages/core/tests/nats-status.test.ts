// connectNats onStatus + the connection gauge across a real server restart (#91).
// Skipped without a nats-server binary (set NATS_SERVER_BIN), like rollout.test.ts.
import { strict as assert } from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { connect } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { connectNats, drain, publishResult } from "../src/nats/index.ts";
import { createKnightMetrics } from "../src/metrics.ts";
import type { TaskResult } from "../src/contract/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NATS_BIN = process.env["NATS_SERVER_BIN"] ?? ["/usr/local/bin/nats-server", "/usr/bin/nats-server"].find(existsSync) ?? "nats-server";
function hasBin(bin: string): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return (process.env["PATH"] ?? "").split(":").some((d) => existsSync(join(d, bin)));
}
async function waitFor(cond: () => boolean, ms = 15_000, what = "condition") {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`waitFor timed out: ${what}`);
    await sleep(25);
  }
}

describe("NATS status callback (real nats-server) (#91)", { skip: !hasBin(NATS_BIN) && "nats-server not found (set NATS_SERVER_BIN)" }, () => {
  let proc: ChildProcess | undefined;
  let dir = "";
  after(async () => {
    await drain().catch(() => {});
    proc?.kill();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("flips the gauge on disconnect and reconnect, counts the reconnect, and a publish made while down is delivered after it", async () => {
    const port = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, "127.0.0.1", () => {
        const p = (srv.address() as { port: number }).port;
        srv.close(() => resolve(p));
      });
    });
    dir = mkdtempSync(join(tmpdir(), "nats-status-"));
    const start = () => spawn(NATS_BIN, ["-js", "-p", String(port), "-sd", dir], { stdio: "ignore" });
    proc = start();
    const url = `nats://127.0.0.1:${port}`;

    // A stream on the file store (-sd) survives the restart.
    let setup: Awaited<ReturnType<typeof connect>> | undefined;
    for (let i = 0; i < 100 && !setup; i++) {
      try { setup = await connect({ servers: url }); } catch { await sleep(100); }
    }
    assert.ok(setup, "setup connection");
    const jsm = await jetstreamManager(setup);
    await jsm.streams.add({ name: "RESULTS", subjects: ["fleet-a.results.>"] });
    await setup.close();

    const metrics = createKnightMetrics({ runtime: "pi", knight: "k" });
    const seen: boolean[] = [];
    const onStatus = (up: boolean) => { seen.push(up); metrics.setNatsConnected(up); };
    let connectedOnce = false;
    for (let i = 0; i < 100 && !connectedOnce; i++) {
      try { await connectNats({ natsUrl: url, knightName: "K", resultPublishRetryMs: 30_000 }, "test-status", onStatus); connectedOnce = true; } catch { await sleep(100); }
    }
    assert.ok(connectedOnce, "connected");
    assert.deepEqual(seen, [true]);
    assert.match(await metrics.registry.metrics(), /roundtable_knight_nats_connected\{[^}]*\} 1/);

    proc.kill();
    await waitFor(() => seen.includes(false), 15_000, "disconnect callback");
    const down = await metrics.registry.metrics();
    assert.match(down, /roundtable_knight_nats_connected\{[^}]*\} 0/);
    assert.match(down, /roundtable_knight_nats_reconnects_total\{[^}]*\} 0/);

    // Publish while down; the retry delivers it once the server (with its stream) is back.
    const res: TaskResult = {
      task_id: "t9", knight: "K", success: true, result: "ok", duration_ms: 1, cost: 0,
      tokens: { input: 0, output: 0 }, model: "m", timestamp: new Date().toISOString(),
    };
    const pending = publishResult("t9", res);
    await sleep(500);
    proc = start();
    await waitFor(() => seen[seen.length - 1] === true, 20_000, "reconnect callback");
    const up = await metrics.registry.metrics();
    assert.match(up, /roundtable_knight_nats_connected\{[^}]*\} 1/);
    assert.match(up, /roundtable_knight_nats_reconnects_total\{[^}]*\} 1/);
    await pending;
    const check = await connect({ servers: url });
    try {
      const info = await (await jetstreamManager(check)).streams.info("RESULTS");
      assert.equal(info.state.messages, 1, "exactly one stored result");
    } finally {
      await check.close();
    }
  });
});
