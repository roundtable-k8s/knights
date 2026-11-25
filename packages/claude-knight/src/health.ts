import http from "node:http";
import type { KnightConfig } from "./config.js";
import { introspectOptions } from "./session-source.js";
import { registry } from "./metrics.js";
import { getStatus as getNatsStatus, handleIntrospect, introspectRequestFromQuery } from "@roundtable/knight-core";

let server: http.Server | null = null;
let skillCount = 0;
let activeTaskCount = 0;
let degradedReason: string | null = null;
let draining = false;

export function setSkillCount(n: number): void {
  skillCount = n;
}
export function setActiveTaskCount(n: number): void {
  activeTaskCount = n;
}
/** SIGTERM received: /ready goes 503 ("draining") so the pod leaves Service endpoints while tasks finish. */
export function setDraining(v: boolean): void {
  draining = v;
}
/** Mark the knight degraded (readiness 503 with reason) or recovered (null). */
export function setDegradedReason(reason: string | null): void {
  degradedReason = reason;
}
export function getDegradedReason(): string | null {
  return degradedReason;
}

/**
 * Same endpoints and probe semantics as pi-knight: /health is liveness (always
 * 200 while the process is up, so the startup probe passes in degraded state),
 * /ready is 200 only when NATS is connected and nothing marked the knight
 * degraded (missing credential, plan reserve reached).
 */
export function startHealthServer(config: KnightConfig): void {
  const startTime = Date.now();
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const json = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, url.pathname === "/introspect" ? 2 : 0));
    };
    try {
      switch (url.pathname) {
        case "/health":
          return json(200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000), knight: config.knightName });
        case "/ready": {
          const nats = getNatsStatus();
          const ready = nats.connected && degradedReason == null && !draining;
          return json(ready ? 200 : 503, {
            status: ready ? "ready" : draining ? "draining" : degradedReason != null ? "degraded" : "not_ready",
            ...(degradedReason != null ? { degradedReason } : {}),
            nats: nats.connected ? "connected" : "disconnected",
            activeTasks: activeTaskCount,
            skillsLoaded: skillCount,
            model: config.claudeModel ?? "claude-code-default",
            runtime: "claude-knight",
            claudeRuntime: config.runtime,
            billing: config.authMode,
            knight: config.knightName,
          });
        }
        case "/introspect": {
          return json(200, await handleIntrospect(introspectRequestFromQuery(url.searchParams), introspectOptions(config)));
        }
        case "/metrics":
          res.writeHead(200, { "Content-Type": registry.contentType });
          return res.end(await registry.metrics());
        default:
          res.writeHead(404);
          return res.end("Not found");
      }
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.listen(config.metricsPort);
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
