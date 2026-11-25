/**
 * Live task activity events (roundtable-k8s/roundtable#249):
 * core NATS, fire-and-forget, subject `<prefix>.activity.<Knight>.<taskId>`.
 * Never stored in JetStream. Every preview is truncated and redacted here, before
 * anything is published. Publish failures are logged and never fail a task.
 */
import { log } from "@roundtable/knight-core";

export const ACTIVITY_VERSION = 1;
export const MAX_EVENT_BYTES = 8 * 1024;
export const PREVIEW_MAX = 500;
export const ARG_SUMMARY_MAX = 200;
/** Per-task budget for non-lifecycle events. */
export const MAX_EVENTS_PER_SEC = 20;

export type ActivityType =
  | "task.started"
  | "task.heartbeat"
  | "task.finished"
  | "tool.started"
  | "tool.finished"
  | "assistant.message";

export interface ActivityEvent {
  v: number;
  type: ActivityType;
  ts: string;
  knight: string;
  pod: string;
  node: string;
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  seq: number;
  [k: string]: unknown;
}

const REDACTED = "[REDACTED]";
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
  // KEY=value / "key": "value" for secret-looking names (env dumps, JSON)
  /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential|private[_-]?key|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, ...groups) => {
      if (re.source.startsWith("\\b(https?")) return `${groups[0]}${REDACTED}@`;
      if (re.source.startsWith("\\b([A-Za-z0-9_.-]*(?:token")) return `${groups[0]}${groups[1]}${REDACTED}`;
      if (/^(authorization|proxy-authorization)/i.test(m)) return `${m.split(/[:=]/)[0]}: ${REDACTED}`;
      return REDACTED;
    });
  }
  return out;
}

/** Tool input fields that may carry secrets or file contents: never summarised. */
const SENSITIVE_INPUT_KEYS = /^(env|headers?|authorization|token|password|secret|credentials?|content|new_string|old_string|edits)$/i;

/** Truncate, then redact. Truncation first bounds the work; a cut token is still caught by the patterns. */
export function activityPreview(text: unknown, max = PREVIEW_MAX): { text: string; truncated: boolean } {
  const s = typeof text === "string" ? text : "";
  const cut = s.length > max;
  // redact before cutting too, so a secret straddling the boundary can't leak a prefix
  const redacted = redactSecrets(s);
  const out = redacted.length > max ? redacted.slice(0, max) : redacted;
  return { text: out, truncated: cut || redacted.length > max };
}

/** Short, redacted summary of a tool call's arguments, skipping known-sensitive fields. */
export function summarizeToolInput(input: unknown): { text: string; truncated: boolean } {
  if (input == null || typeof input !== "object") return activityPreview(typeof input === "string" ? input : "", ARG_SUMMARY_MAX);
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_INPUT_KEYS.test(k)) continue;
    safe[k] = v;
  }
  // Prefer the most telling single field
  const pick = ["command", "file_path", "path", "pattern", "url", "query", "description"].find((k) => typeof safe[k] === "string");
  return activityPreview(pick ? (safe[pick] as string) : JSON.stringify(safe), ARG_SUMMARY_MAX);
}

export interface PodIdentity {
  pod: string;
  node: string;
}

export function podIdentity(env: NodeJS.ProcessEnv, hostname: string): PodIdentity {
  return { pod: env["POD_NAME"] || hostname, node: env["NODE_NAME"] || hostname };
}

export type PublishFn = (subject: string, payload: string) => void;

export interface TaskActivityInit {
  knight: string;
  taskId: string;
  subject: string;
  identity: PodIdentity;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  slot?: number;
  concurrency?: number;
  queuedFor?: number;
  /** none: no previews of assistant text, tool arguments or tool output. */
  content?: "none" | "preview";
  publish: PublishFn;
  now?: () => number;
}

export interface InflightInfo {
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  startedAt: string;
  lastHeartbeatAt: string | null;
  workDir?: string;
}

/** One running task's activity stream: per-task seq numbers, rate limit and counters. */
export class TaskActivity {
  seq = 0;
  readonly startedAtMs: number;
  lastHeartbeatMs: number | null = null;
  workDir?: string;
  turns = 0;
  currentTool: string | null = null;
  private toolStart = new Map<string, number>();
  private windowStart = 0;
  private windowCount = 0;
  private now: () => number;

  constructor(private init: TaskActivityInit) {
    this.now = init.now ?? Date.now;
    this.startedAtMs = this.now();
  }

  private emit(type: ActivityType, fields: Record<string, unknown>, lifecycle: boolean): void {
    const t = this.now();
    if (!lifecycle) {
      if (t - this.windowStart >= 1000) {
        this.windowStart = t;
        this.windowCount = 0;
      }
      if (this.windowCount >= MAX_EVENTS_PER_SEC) return; // sampled out; seq gap tells consumers
      this.windowCount++;
    }
    const i = this.init;
    let ev: ActivityEvent = {
      v: ACTIVITY_VERSION,
      type,
      ts: new Date(t).toISOString(),
      knight: i.knight,
      pod: i.identity.pod,
      node: i.identity.node,
      taskId: i.taskId,
      ...(i.runId ? { runId: i.runId } : {}),
      ...(i.chainName ? { chainName: i.chainName } : {}),
      ...(i.stepName ? { stepName: i.stepName } : {}),
      ...(i.model ? { model: i.model } : {}),
      seq: ++this.seq,
      ...fields,
    };
    let payload = JSON.stringify(ev);
    if (Buffer.byteLength(payload) > MAX_EVENT_BYTES) {
      // Drop previews as a last resort; lifecycle fields always fit.
      for (const k of ["preview", "output", "args", "text"]) delete ev[k];
      ev = { ...ev, truncated: true };
      payload = JSON.stringify(ev);
    }
    try {
      i.publish(i.subject, payload);
    } catch (err) {
      log.debug("Activity publish failed", { taskId: i.taskId, error: String(err) });
    }
  }

  private preview(text: unknown, max = PREVIEW_MAX): { text: string; truncated: boolean } | null {
    return this.init.content === "none" ? null : activityPreview(text, max);
  }

  started(): void {
    const i = this.init;
    this.emit(
      "task.started",
      {
        ...(i.slot != null ? { slot: i.slot } : {}),
        ...(i.concurrency != null ? { concurrency: i.concurrency } : {}),
        ...(i.queuedFor != null ? { queuedFor: i.queuedFor } : {}),
      },
      true,
    );
  }

  heartbeat(extra: { turns?: number; tokens?: unknown; cost?: number } = {}): void {
    this.lastHeartbeatMs = this.now();
    this.emit(
      "task.heartbeat",
      { turns: extra.turns ?? this.turns, ...(extra.tokens ? { tokens: extra.tokens } : {}), ...(extra.cost != null ? { cost: extra.cost } : {}), ...(this.currentTool ? { currentTool: this.currentTool } : {}) },
      true,
    );
  }

  toolStarted(id: string, name: string, input: unknown): void {
    this.toolStart.set(id, this.now());
    this.currentTool = name;
    const args = this.init.content === "none" ? null : summarizeToolInput(input);
    this.emit("tool.started", { toolUseId: id, tool: name, ...(args ? { args: args.text, truncated: args.truncated } : {}) }, false);
  }

  toolFinished(id: string, name: string, isError: boolean, output: unknown): void {
    const t0 = this.toolStart.get(id);
    this.toolStart.delete(id);
    if (this.currentTool === name) this.currentTool = null;
    const p = this.preview(output);
    this.emit(
      "tool.finished",
      { toolUseId: id, tool: name, isError, ...(t0 != null ? { durationMs: this.now() - t0 } : {}), ...(p ? { output: p.text, truncated: p.truncated } : {}) },
      false,
    );
  }

  assistantMessage(text: string): void {
    this.turns++;
    const p = this.preview(text);
    this.emit("assistant.message", p ? { text: p.text, truncated: p.truncated } : {}, false);
  }

  private done = false;

  finished(f: { success: boolean; errorClass?: string; cost?: number; tokens?: unknown; turns?: number }): void {
    if (this.done) return;
    this.done = true;
    this.emit(
      "task.finished",
      {
        success: f.success,
        ...(f.errorClass ? { errorClass: f.errorClass } : {}),
        durationMs: this.now() - this.startedAtMs,
        ...(f.cost != null ? { cost: f.cost } : {}),
        ...(f.tokens ? { tokens: f.tokens } : {}),
        ...(f.turns != null ? { turns: f.turns } : {}),
      },
      true,
    );
  }

  inflight(): InflightInfo {
    const i = this.init;
    return {
      taskId: i.taskId,
      ...(i.runId ? { runId: i.runId } : {}),
      ...(i.chainName ? { chainName: i.chainName } : {}),
      ...(i.stepName ? { stepName: i.stepName } : {}),
      ...(i.model ? { model: i.model } : {}),
      startedAt: new Date(this.startedAtMs).toISOString(),
      lastHeartbeatAt: this.lastHeartbeatMs == null ? null : new Date(this.lastHeartbeatMs).toISOString(),
      ...(this.workDir ? { workDir: this.workDir } : {}),
    };
  }
}

// ── Registry of running tasks (also feeds introspect `inflight`) ──
const tasks = new Map<string, TaskActivity>();

export function registerActivity(a: TaskActivity, taskId: string): void {
  tasks.set(taskId, a);
}
export function unregisterActivity(taskId: string): void {
  tasks.delete(taskId);
}
export function getActivity(taskId: string): TaskActivity | undefined {
  return tasks.get(taskId);
}
export function inflightTasks(): InflightInfo[] {
  return [...tasks.values()].map((a) => a.inflight());
}
