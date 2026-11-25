/**
 * Claude plan limit tracking.
 *
 * Claude Code reports rate_limit_event messages carrying how much of each plan
 * window (5-hour, 7-day, …) is used. In subscription mode the fleet shares those
 * windows with the owner's own Claude Code and chat use, so the knight keeps a
 * reserve: once a window passes CLAUDE_PLAN_RESERVE (default 0.8 = 80% used), or
 * Claude reports the window as rejected, new tasks fail fast with the reset time
 * instead of draining the rest of the week. Set CLAUDE_PLAN_RESERVE=1 to disable.
 */
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import client from "prom-client";
import { registry } from "./runtime-metrics.js";

const utilizationGauge = new client.Gauge({
  name: "roundtable_knight_plan_utilization",
  help: "Latest reported Claude plan utilization per window (0-1)",
  labelNames: ["window"] as const,
  registers: [registry],
});

interface WindowState {
  utilization?: number;
  status: SDKRateLimitInfo["status"];
  resetsAtMs?: number;
  updatedAtMs: number;
}

const windows = new Map<string, WindowState>();

/** Normalize utilization to 0-1 (accepts either a fraction or a percentage). */
export function normalizeUtilization(u: number | undefined): number | undefined {
  if (typeof u !== "number" || !Number.isFinite(u)) return undefined;
  return u > 1 ? u / 100 : u;
}

/** Normalize an epoch timestamp in seconds or milliseconds to milliseconds. */
export function normalizeEpochMs(t: number | undefined): number | undefined {
  if (typeof t !== "number" || !Number.isFinite(t) || t <= 0) return undefined;
  return t < 1e12 ? t * 1000 : t;
}

export function recordRateLimit(info: SDKRateLimitInfo, now = Date.now()): void {
  const window = info.rateLimitType ?? "unknown";
  const utilization = normalizeUtilization(info.utilization);
  windows.set(window, {
    utilization,
    status: info.status,
    resetsAtMs: normalizeEpochMs(info.resetsAt),
    updatedAtMs: now,
  });
  if (utilization != null) utilizationGauge.labels(window).set(utilization);
}

export interface ReserveCheck {
  blocked: boolean;
  reason?: string;
}

/**
 * Decide whether a new task may start. A window stops blocking once its reset
 * time has passed, even before a fresh rate_limit_event arrives.
 */
export function checkReserve(reserve: number, now = Date.now()): ReserveCheck {
  for (const [window, w] of windows) {
    if (w.resetsAtMs != null && w.resetsAtMs <= now) continue;
    const resets = w.resetsAtMs != null ? ` (resets ${new Date(w.resetsAtMs).toISOString()})` : "";
    if (w.status === "rejected") {
      return { blocked: true, reason: `Claude plan ${window} limit reached${resets}` };
    }
    if (reserve < 1 && w.utilization != null && w.utilization >= reserve) {
      return {
        blocked: true,
        reason: `Claude plan ${window} window ${(w.utilization * 100).toFixed(0)}% used — at the knight reserve of ${(reserve * 100).toFixed(0)}%${resets}`,
      };
    }
  }
  return { blocked: false };
}

export function snapshot(): Record<string, WindowState> {
  return Object.fromEntries(windows);
}

/** Test hook. */
export function resetPlanLimits(): void {
  windows.clear();
  lastProbeAtMs = 0;
  probing = null;
}

/** How often a refusing knight re-checks the real usage (ms). */
export const RECHECK_INTERVAL_MS = 5 * 60_000;

let lastProbeAtMs = 0;
let probing: Promise<void> | null = null;

/**
 * Like checkReserve, but while blocked it refreshes the stored reading with
 * `probe` (a cheap Claude call whose rate_limit_event feeds recordRateLimit) at
 * most once per `intervalMs`, so a knight recovers after usage drops (owner reset
 * or bought more) instead of staying refused until the recorded reset time.
 * Concurrent tasks share one probe. If the probe throws, the old reading is kept.
 */
export async function checkReserveRefreshing(
  reserve: number,
  probe: () => Promise<void>,
  opts: { now?: () => number; intervalMs?: number; onCleared?: () => void } = {},
): Promise<ReserveCheck> {
  const now = opts.now ?? Date.now;
  const interval = opts.intervalMs ?? RECHECK_INTERVAL_MS;
  const was = checkReserve(reserve, now());
  if (!was.blocked) return was;
  if (probing) await probing;
  else if (now() - lastProbeAtMs >= interval) {
    lastProbeAtMs = now();
    const previous = new Map(windows);
    windows.clear();
    probing = probe()
      .catch(() => {
        // Keep the old reading for windows the probe did not re-report.
        for (const [k, v] of previous) if (!windows.has(k)) windows.set(k, v);
      })
      .finally(() => {
        probing = null;
      });
    await probing;
  }
  const check = checkReserve(reserve, now());
  if (!check.blocked) opts.onCleared?.();
  return check;
}
