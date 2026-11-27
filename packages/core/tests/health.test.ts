import { test } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import { startHealthServer, stopHealthServer, setDegradedReason, getDegradedReason } from "../src/health.ts";
import { createKnightMetrics } from "../src/metrics.ts";
import { initLogger } from "../src/logger.ts";
import { captureLogs } from "./helpers/log-capture.js";

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

test("health server serves /health, /metrics, extra routes and readyExtras", async () => {
  const port = await freePort();
  const m = createKnightMetrics({ runtime: "test", knight: "T" });
  startHealthServer({
    knightName: "T",
    port,
    registry: m.registry,
    readyExtras: () => ({ model: "x" }),
    routes: { "/introspect": (url) => ({ q: url.searchParams.get("a") }) },
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${port}`;
  try {
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.status, "ok");
    assert.equal(h.knight, "T");
    assert.deepEqual(await (await fetch(`${base}/introspect?a=1`)).json(), { q: "1" });
    assert.match(await (await fetch(`${base}/metrics`)).text(), /roundtable_knight_tasks_total/);
    const ready = await fetch(`${base}/ready`);
    assert.equal(ready.status, 503); // NATS not connected
    assert.equal((await ready.json()).model, "x");
    assert.equal((await fetch(`${base}/nope`)).status, 404);
    setDegradedReason("why");
    assert.equal(getDegradedReason(), "why");
    assert.equal((await (await fetch(`${base}/ready`)).json()).status, "degraded");
  } finally {
    setDegradedReason(null);
    await stopHealthServer();
  }
});

/** Sends a raw request line (fetch would normalise the target) and resolves with the status code. */
const rawStatus = (port: number, target: string) =>
  new Promise<number>((resolve, reject) => {
    const sock = connect(port, "127.0.0.1", () => {
      sock.write(`GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.on("data", (c) => (data += c.toString()));
    sock.on("end", () => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(data);
      if (m) resolve(Number(m[1]));
      else reject(new Error(`no status line: ${JSON.stringify(data)}`));
    });
    sock.on("error", reject);
  });

test("health server answers 400 to a malformed request URL and keeps serving", async () => {
  const port = await freePort();
  const m = createKnightMetrics({ runtime: "test", knight: "T" });
  startHealthServer({ knightName: "T", port, registry: m.registry });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(await rawStatus(port, "//"), 400);
    assert.equal(await rawStatus(port, "//:80"), 400);
    const h = await (await fetch(`${base}/health`)).json();
    assert.equal(h.status, "ok");
  } finally {
    await stopHealthServer();
  }
});

test("health server answers 500 when an extra route throws and keeps serving", async () => {
  const port = await freePort();
  const m = createKnightMetrics({ runtime: "test", knight: "T" });
  startHealthServer({
    knightName: "T",
    port,
    registry: m.registry,
    routes: {
      "/boom": () => {
        throw new Error("kaboom");
      },
      "/boom-async": async () => {
        throw new Error("async kaboom");
      },
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/boom`);
    assert.equal(r.status, 500);
    assert.equal((await r.json()).error, "kaboom");
    assert.equal((await fetch(`${base}/boom-async`)).status, 500);
    assert.equal((await fetch(`${base}/health`)).status, 200);
  } finally {
    await stopHealthServer();
  }
});

test("health server logs a listen error (EADDRINUSE on a taken port) with the port and does not throw", async () => {
  // Hold the port on the wildcard address so the health server's listen() (no host) fails with EADDRINUSE.
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, resolve));
  const port = (blocker.address() as { port: number }).port;
  const logs = captureLogs();
  initLogger("T", "info");
  const m = createKnightMetrics({ runtime: "test", knight: "T" });
  try {
    assert.doesNotThrow(() => startHealthServer({ knightName: "T", port, registry: m.registry }));
    await new Promise((r) => setTimeout(r, 50));
    const failed = logs.find("health server failed");
    assert.ok(failed, "expected the listen error to be logged");
    assert.equal(failed.level, "error");
    assert.equal(failed.port, port);
    assert.equal(failed.code, "EADDRINUSE");
  } finally {
    await stopHealthServer();
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test("health server ends the response and keeps serving when /metrics fails after its headers are sent", async () => {
  const port = await freePort();
  // The 200 header goes out before the scrape fails, so the error path cannot write a 500: the outer catch must just end the response.
  const registry = { contentType: "text/plain", metrics: async () => Promise.reject(new Error("scrape failed")) };
  startHealthServer({ knightName: "T", port, registry: registry as never });
  await new Promise((r) => setTimeout(r, 50));
  const base = `http://127.0.0.1:${port}`;
  try {
    const metrics = await fetch(`${base}/metrics`);
    assert.equal(metrics.status, 200);
    assert.equal(await metrics.text(), "");
    assert.equal((await (await fetch(`${base}/health`)).json()).status, "ok");
  } finally {
    await stopHealthServer();
  }
});
