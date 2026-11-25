import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { startHealthServer, stopHealthServer, setDegradedReason, getDegradedReason } from "../src/health.ts";
import { createKnightMetrics } from "../src/metrics.ts";

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
