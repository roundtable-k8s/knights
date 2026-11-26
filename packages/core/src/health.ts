import http from "node:http";
import type { Registry } from "prom-client";
import { getStatus as getNatsStatus } from "./nats/index.js";
import { log } from "./logger.js";

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

/** An extra JSON route (e.g. /introspect). The return value is served as 200 JSON, indented. */
export type HealthRoute = (url: URL) => unknown | Promise<unknown>;

export interface HealthServerOptions {
  knightName: string;
  /** Port for /health, /ready, /metrics and the extra routes. */
  port: number;
  /** Registry served on /metrics. */
  registry: Registry;
  /** Runtime-specific fields merged into the /ready body (before `knight`). */
  readyExtras?: () => Record<string, unknown>;
  /** Extra routes keyed by exact pathname, e.g. { "/introspect": handler }. */
  routes?: Record<string, HealthRoute>;
}

/**
 * /health is liveness (always 200 while the process is up, so the startup probe passes in
 * degraded state), /ready is 200 only when NATS is connected, nothing marked the knight
 * degraded (missing credential, plan reserve reached) and it is not draining.
 */
export function startHealthServer(opts: HealthServerOptions): void {
  const startTime = Date.now();
  server = http.createServer(async (req, res) => {
    const json = (code: number, body: unknown, indent = 0) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, indent));
    };
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      // A malformed request target (e.g. "GET //") must not reject this handler: answer 400 and keep serving.
      return json(400, { error: "invalid request URL" });
    }
    try {
      const route = opts.routes && Object.hasOwn(opts.routes, url.pathname) ? opts.routes[url.pathname] : undefined;
      if (route) return json(200, await route(url), 2);
      switch (url.pathname) {
        case "/health":
          return json(200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000), knight: opts.knightName });
        case "/ready": {
          const nats = getNatsStatus();
          const ready = nats.connected && degradedReason == null && !draining;
          return json(ready ? 200 : 503, {
            status: ready ? "ready" : draining ? "draining" : degradedReason != null ? "degraded" : "not_ready",
            ...(degradedReason != null ? { degradedReason } : {}),
            nats: nats.connected ? "connected" : "disconnected",
            activeTasks: activeTaskCount,
            skillsLoaded: skillCount,
            ...opts.readyExtras?.(),
            knight: opts.knightName,
          });
        }
        case "/metrics":
          res.writeHead(200, { "Content-Type": opts.registry.contentType });
          return res.end(await opts.registry.metrics());
        default:
          res.writeHead(404);
          return res.end("Not found");
      }
    } catch (err) {
      json(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });
  server.on("error", (err) => {
    log.error("health server failed", { port: opts.port, error: err.message, code: (err as NodeJS.ErrnoException).code });
  });
  server.listen(opts.port);
}

export function stopHealthServer(): Promise<void> {
  return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
}
