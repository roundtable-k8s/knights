/**
 * Live task activity events, contract v1 (roundtable-k8s/roundtable#249,
 * roundtable `docs/design/task-activity-events.md`).
 *
 * Core-NATS, fire-and-forget events on `<prefix>.activity.<Knight>.<taskId>` so a dashboard
 * can see what a pod is doing before the result lands. Never JetStream, never fatal:
 * a publish failure is logged at debug and the task carries on. Every free-text field is
 * redacted and bounded (500-char previews, 200-char argument summaries, 8 KiB per event).
 *
 * Also keeps the registry of in-flight tasks that introspection reports (`listInflight`).
 */
import { log } from "./logger.js";
import { getConnection } from "./nats/index.js";

export const ACTIVITY_VERSION = 1;
export const MAX_EVENT_BYTES = 8 * 1024;
export const MAX_PREVIEW_CHARS = 500;
export const MAX_ARGS_CHARS = 200;
/** Per-task cap on tool/assistant events; lifecycle events and heartbeats are never dropped. */
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
  node?: string;
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  seq: number;
  truncated?: boolean;
  [field: string]: unknown;
}

// ─── Redaction ──────────────────────────────────────────────────────

const REDACTED = "[REDACTED]";

interface SecretRule {
  re: RegExp;
  /** Token-shaped (high confidence, no surrounding context needed): part of the `tokens` scope. */
  token?: boolean;
  /** Replacement; defaults to `[REDACTED]`. */
  replace?: (match: string, ...groups: string[]) => string;
}

/**
 * Secret patterns: the union of what pi-knight (`hooks.ts`) and claude-knight
 * (`activity.ts`) redacted before they shared this module. Order matters: whole
 * blocks and headers first, then tokens, then generic `key=value` pairs.
 */
export const SECRET_RULES: readonly SecretRule[] = [
  // PEM private keys: the whole block (or to end of text when the END line was cut off)
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, token: true },
  // a bare BEGIN line of any private key type (pi-knight)
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi, token: true },
  // Authorization / Proxy-Authorization headers: keep the header name
  { re: /\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]*/gi, replace: (_m, name) => `${name}: ${REDACTED}` },
  { re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, token: true },
  { re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, token: true }, // Anthropic keys
  { re: /\bsk-[A-Za-z0-9_-]{16,}/g, token: true }, // OpenAI-style keys
  { re: /sk-[A-Za-z0-9]{40,}/g, token: true }, // OpenAI keys (pi-knight)
  // GitHub tokens: the longer rules (which allow `_`) first, so a shorter match can't leave a tail
  { re: /ghp_[A-Za-z0-9_]{36,}/g, token: true }, // GitHub PATs (pi-knight)
  { re: /ghs_[A-Za-z0-9_]{36,}/g, token: true }, // GitHub app tokens (pi-knight)
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, token: true }, // other GitHub tokens
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, token: true }, // fine-grained GitHub PATs
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, token: true }, // Slack tokens
  { re: /xoxb-[A-Za-z0-9-]+/g, token: true }, // Slack bot tokens (pi-knight)
  { re: /AKIA[0-9A-Z]{16}/g, token: true }, // AWS access key ids
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, token: true }, // JWTs
  // credentials in URLs: keep the scheme
  { re: /\b(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // KEY=value / "key": "value" for secret-looking names (env dumps, JSON): keep the key
  {
    re: /\b([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|credential|private[_-]?key|auth)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}]+)/gi,
    replace: (_m, key, sep) => `${key}${sep}${REDACTED}`,
  },
  // api_key / access_token / bearer = <long value> (pi-knight)
  { re: /(?:api[_-]?key|apikey|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer)\s*[:=]\s*['"]?[A-Za-z0-9_\-/.+=]{20,}/gi, token: true },
];

/**
 * `all`: every rule, for activity previews and logs. `tokens`: only token-shaped secrets
 * (keys, PATs, JWTs, PEM blocks), for text the model reads or writes, where redacting
 * `password=...` style context would corrupt code.
 */
export type RedactScope = "all" | "tokens";

/** Replace every known secret pattern in `text`. */
export function redactSecrets(text: string, scope: RedactScope = "all"): string {
  let out = text;
  for (const { re, replace, token } of SECRET_RULES) {
    if (scope === "tokens" && !token) continue;
    re.lastIndex = 0;
    out = replace ? out.replace(re, replace as (m: string, ...g: string[]) => string) : out.replace(re, REDACTED);
  }
  return out;
}

/** True when `text` contains anything `redactSecrets` would replace. */
export function containsSecret(text: string, scope: RedactScope = "all"): boolean {
  return redactSecrets(text, scope) !== text;
}

// ─── Bounding helpers ───────────────────────────────────────────────

/** Redact secrets, then cut to `max` chars. Returns the text and whether it was cut. */
export function boundText(text: string, max: number): { text: string; truncated: boolean } {
  // Pre-cut so redaction never scans megabytes of tool output. Redact BEFORE the final
  // cut so a secret straddling the limit is replaced whole instead of half-leaked.
  const pre = text.length > max * 8 ? text.slice(0, max * 8) : text;
  const clean = redactSecrets(pre);
  if (clean.length <= max && pre.length === text.length) return { text: clean, truncated: false };
  return { text: clean.slice(0, max), truncated: true };
}

/** Argument keys whose values are file contents or credentials: never summarised. */
const SENSITIVE_ARG =
  /^(content|contents|text|new_?string|old_?string|new_?text|old_?text|edits|data|body|env|headers?|authorization|token|password|secret|credentials?|api_?key)$/i;

/** Argument keys that alone say what a tool call does; the first one present is the summary. */
const TELLING_ARGS = ["command", "file_path", "path", "pattern", "url", "query", "description"];

/**
 * Short summary of tool arguments, without file contents or credentials: the most telling
 * single field (`command`, `file_path`, ...) when there is one, else `key=value` pairs.
 */
export function summarizeArgs(args: unknown): { text: string; truncated: boolean } {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return boundText(typeof args === "string" ? args : (JSON.stringify(args) ?? ""), MAX_ARGS_CHARS);
  }
  const entries = Object.entries(args as Record<string, unknown>);
  const pick = TELLING_ARGS.find((k) => typeof (args as Record<string, unknown>)[k] === "string");
  if (pick) return boundText((args as Record<string, string>)[pick]!, MAX_ARGS_CHARS);
  let cut = false;
  const raw = entries
    .map(([k, v]) => {
      if (SENSITIVE_ARG.test(k)) return `${k}=<omitted>`;
      const s = typeof v === "string" ? v : (JSON.stringify(v) ?? "");
      if (s.length > 120) cut = true;
      return `${k}=${s.length > 120 ? s.slice(0, 120) + "…" : s}`;
    })
    .join(" ");
  const b = boundText(raw, MAX_ARGS_CHARS);
  return cut ? { ...b, truncated: true } : b;
}

/** Fields shed (in this order of preference) when an event is over MAX_EVENT_BYTES. */
const SHEDDABLE = ["preview", "outputPreview", "argsSummary", "currentTool", "error"];

/** Serialize an event within MAX_EVENT_BYTES, shedding previews first if it is oversized. */
export function encodeEvent(ev: ActivityEvent): string {
  let json = JSON.stringify(ev);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  const slim: ActivityEvent = { ...ev, truncated: true };
  for (const k of SHEDDABLE) delete slim[k];
  json = JSON.stringify(slim);
  if (Buffer.byteLength(json) <= MAX_EVENT_BYTES) return json;
  // Pathological identity fields (huge model/stepName): keep only the routing keys.
  const { v, type, ts, knight, pod, taskId, seq } = ev;
  return JSON.stringify({ v, type, ts, knight: knight.slice(0, 200), pod: pod.slice(0, 200), taskId: String(taskId).slice(0, 200), seq, truncated: true });
}

// ─── Identity, subjects, error classes ──────────────────────────────

export interface PodIdentity {
  pod: string;
  node?: string;
}

/** Pod identity from the downward API env (POD_NAME / NODE_NAME); the pod falls back to `hostname`, the node is omitted. */
export function podIdentity(env: NodeJS.ProcessEnv, hostname: string): PodIdentity {
  return { pod: env["POD_NAME"] || hostname, ...(env["NODE_NAME"] ? { node: env["NODE_NAME"] } : {}) };
}

/** `<prefix>` from `<prefix>.results`. */
export function natsPrefix(config: { natsResultsPrefix: string }): string {
  return config.natsResultsPrefix.replace(/\.results$/, "");
}

/** Subject token safe for a NATS subject (no dots, wildcards or spaces). */
export function subjectToken(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

/** `<prefix>.activity.<Knight>.<taskId>`. */
export function activitySubject(prefix: string, knight: string, taskId: string): string {
  return `${prefix}.activity.${subjectToken(knight)}.${subjectToken(taskId)}`;
}

/** `errorClass` values of contract v1. */
export type ErrorClass = "timeout" | "cancelled" | "model_error" | "tool_error" | "internal" | "other";

/** Coarse error class of a task failure, for dashboards. */
export function classifyError(error: string): ErrorClass {
  if (/timed? ?out|timeout|deadline/i.test(error)) return "timeout";
  if (/abort|cancel/i.test(error)) return "cancelled";
  if (/model|provider|rate.?limit|overloaded|context|usage.?limit|\b(?:429|529)\b/i.test(error)) return "model_error";
  if (/\btool\b/i.test(error)) return "tool_error";
  return "other";
}

// ─── Publisher ──────────────────────────────────────────────────────

export type ActivityPublish = (subject: string, payload: string) => void;

/** Core NATS publish on the shared connection (never JetStream). */
export const natsActivityPublish: ActivityPublish = (subject, payload) => {
  getConnection()?.publish(subject, payload);
};

export interface TaskActivityInit {
  knight: string;
  /** `<prefix>` of the table (see `natsPrefix`). */
  prefix: string;
  taskId: string;
  identity: PodIdentity;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  /** Concurrency slot (0-based) and the knight's concurrency, reported on task.started. */
  slot?: number;
  concurrency?: number;
  /** ms between publish and pickup, when the dispatcher stamped the task. */
  queuedFor?: number;
  /** Working directory name, reported in the in-flight registry. */
  workDir?: string;
  /** `none` drops previews and argument summaries. Default `preview`. */
  content?: "none" | "preview";
  /** Defaults to `natsActivityPublish`. */
  publish?: ActivityPublish;
  now?: () => number;
}

/** What introspection reports for a running task. */
export interface InflightTask {
  taskId: string;
  runId?: string;
  chainName?: string;
  stepName?: string;
  model?: string;
  startedAt: string;
  lastHeartbeatAt: string;
  workDir?: string;
}

export interface Usage {
  input?: number;
  output?: number;
  cacheRead?: number;
  /** USD */
  cost?: number;
}

const registry = new Map<string, TaskActivity>();

/** Tasks currently executing on this pod (what introspection reports as `inflight`). */
export function listInflight(): InflightTask[] {
  return [...registry.values()].map((a) => a.inflight());
}

/** The activity stream of a running task, if any. */
export function getActivity(taskId: string): TaskActivity | undefined {
  return registry.get(taskId);
}

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

/** Activity stream for one task. All methods are safe to call at any time and never throw. */
export class TaskActivity {
  readonly taskId: string;
  readonly subject: string;
  private seq = 0;
  private done = false;
  private turns = 0;
  private tokens = { input: 0, output: 0, cacheRead: 0 };
  private cost = 0;
  private usageSeen = false;
  private currentTool: string | undefined;
  private readonly toolStart = new Map<string, number>();
  private bucket = MAX_EVENTS_PER_SEC;
  private bucketAt: number;
  private readonly startedMs: number;
  private lastHeartbeatMs: number;
  private readonly now: () => number;
  private readonly publish: ActivityPublish;
  private unsub: (() => void) | undefined;

  constructor(private readonly init: TaskActivityInit) {
    this.taskId = init.taskId;
    this.subject = activitySubject(init.prefix, init.knight, init.taskId);
    this.now = init.now ?? Date.now;
    this.publish = init.publish ?? natsActivityPublish;
    this.startedMs = this.now();
    this.lastHeartbeatMs = this.startedMs;
    this.bucketAt = this.startedMs;
  }

  private get previews(): boolean {
    return this.init.content !== "none";
  }

  private emit(type: ActivityType, fields: Record<string, unknown>, droppable: boolean): void {
    try {
      // Sampled events consume no seq: a seq gap always means loss in transit.
      if (droppable && !this.takeToken()) return;
      const i = this.init;
      const ev: ActivityEvent = {
        v: ACTIVITY_VERSION,
        type,
        ts: new Date(this.now()).toISOString(),
        knight: i.knight,
        pod: i.identity.pod,
        ...(i.identity.node ? { node: i.identity.node } : {}),
        taskId: i.taskId,
        ...(i.runId ? { runId: i.runId } : {}),
        ...(i.chainName ? { chainName: i.chainName } : {}),
        ...(i.stepName ? { stepName: i.stepName } : {}),
        ...(i.model ? { model: i.model } : {}),
        seq: ++this.seq,
        ...fields,
      };
      this.publish(this.subject, encodeEvent(ev));
    } catch (err) {
      log.debug("Activity publish failed", { taskId: this.init.taskId, type, error: String(err) });
    }
  }

  private takeToken(): boolean {
    const t = this.now();
    this.bucket = Math.min(MAX_EVENTS_PER_SEC, this.bucket + ((t - this.bucketAt) / 1000) * MAX_EVENTS_PER_SEC);
    this.bucketAt = t;
    if (this.bucket < 1) return false;
    this.bucket -= 1;
    return true;
  }

  private bounded(field: string, text: string, max: number): Record<string, unknown> {
    if (!this.previews) return {};
    const b = boundText(text, max);
    return { [field]: b.text, ...(b.truncated ? { truncated: true } : {}) };
  }

  private counters(): Record<string, unknown> {
    return {
      turns: this.turns,
      ...(this.usageSeen
        ? { inputTokens: Math.round(this.tokens.input), outputTokens: Math.round(this.tokens.output), costUsd: this.cost }
        : {}),
    };
  }

  /** Register the task as in flight and emit task.started. */
  started(): void {
    registry.set(this.init.taskId, this);
    const i = this.init;
    this.emit(
      "task.started",
      {
        ...(i.slot != null ? { slot: i.slot } : {}),
        ...(i.concurrency != null ? { concurrency: i.concurrency } : {}),
        ...(i.queuedFor != null ? { queuedFor: Math.max(0, Math.round(i.queuedFor)) } : {}),
      },
      false,
    );
  }

  heartbeat(): void {
    if (this.done) return;
    this.lastHeartbeatMs = this.now();
    this.emit("task.heartbeat", { ...this.counters(), ...(this.currentTool ? { currentTool: this.currentTool } : {}) }, false);
  }

  /** Add token/cost usage of one model call to the running totals. */
  addUsage(u: Usage): void {
    this.usageSeen = true;
    this.tokens.input += num(u.input);
    this.tokens.output += num(u.output);
    this.tokens.cacheRead += num(u.cacheRead);
    this.cost += num(u.cost);
  }

  toolStarted(toolCallId: string, tool: string, args: unknown): void {
    this.currentTool = tool;
    this.toolStart.set(toolCallId, this.now());
    let summary: Record<string, unknown> = {};
    if (this.previews) {
      const a = summarizeArgs(args);
      summary = { argsSummary: a.text, ...(a.truncated ? { truncated: true } : {}) };
    }
    this.emit("tool.started", { tool, toolCallId, ...summary }, true);
  }

  /** `durationMs` defaults to the time since `toolStarted` for the same id. */
  toolFinished(toolCallId: string, tool: string, isError: boolean, output: string, durationMs?: number): void {
    const t0 = this.toolStart.get(toolCallId);
    this.toolStart.delete(toolCallId);
    if (this.currentTool === tool) this.currentTool = undefined;
    const d = durationMs ?? (t0 != null ? this.now() - t0 : 0);
    this.emit(
      "tool.finished",
      { tool, toolCallId, durationMs: Math.max(0, Math.round(d)), isError, ...this.bounded("outputPreview", output, MAX_PREVIEW_CHARS) },
      true,
    );
  }

  /** One assistant turn; emits assistant.message when it has text. */
  assistantMessage(text: string): void {
    this.turns++;
    if (text.trim()) this.emit("assistant.message", this.bounded("preview", text, MAX_PREVIEW_CHARS), true);
  }

  /**
   * Emit task.finished (once) and drop the task from the in-flight registry.
   * `errorClass` defaults to `classifyError(error)` on failure; explicit values override it.
   */
  finished(r: {
    success: boolean;
    error?: string;
    errorClass?: string;
    cost?: number;
    tokens?: { input: number; output: number; cacheRead?: number };
    turns?: number;
  }): void {
    if (this.done) return; // a late publishResult failure must not emit a second task.finished
    this.close();
    this.done = true;
    if (r.tokens || r.cost != null) {
      this.usageSeen = true;
      if (r.tokens) this.tokens = { input: num(r.tokens.input), output: num(r.tokens.output), cacheRead: num(r.tokens.cacheRead) };
      if (r.cost != null) this.cost = num(r.cost);
    }
    if (r.turns != null) this.turns = Math.max(0, Math.round(r.turns));
    const errorClass = r.success ? undefined : (r.errorClass ?? classifyError(r.error ?? ""));
    this.emit(
      "task.finished",
      {
        success: r.success,
        ...(errorClass ? { errorClass } : {}),
        ...(r.error ? this.bounded("error", r.error, MAX_PREVIEW_CHARS) : {}),
        durationMs: Math.max(0, this.now() - this.startedMs),
        ...this.counters(),
      },
      false,
    );
  }

  /** Drop the task from the in-flight registry and detach from its session, without emitting. Idempotent. */
  close(): void {
    if (registry.get(this.init.taskId) === this) registry.delete(this.init.taskId);
    this.detach();
  }

  /** Follow a session's events with `listener` until `detach`/`finished`. No-op for sessions without `subscribe`. */
  attach<E>(session: { subscribe?: (l: (e: E) => void) => () => void }, listener: (e: E) => void): void {
    this.detach();
    try {
      this.unsub = session.subscribe?.((e) => {
        try {
          listener(e);
        } catch (err) {
          log.debug("Activity event mapping failed", { error: String(err) });
        }
      });
    } catch (err) {
      log.debug("Activity subscribe failed", { error: String(err) });
    }
  }

  detach(): void {
    try {
      this.unsub?.();
    } catch {
      // ignore
    }
    this.unsub = undefined;
  }

  inflight(): InflightTask {
    const i = this.init;
    return {
      taskId: i.taskId,
      ...(i.runId ? { runId: i.runId } : {}),
      ...(i.chainName ? { chainName: i.chainName } : {}),
      ...(i.stepName ? { stepName: i.stepName } : {}),
      ...(i.model ? { model: i.model } : {}),
      startedAt: new Date(this.startedMs).toISOString(),
      lastHeartbeatAt: new Date(this.lastHeartbeatMs).toISOString(),
      ...(i.workDir ? { workDir: i.workDir } : {}),
    };
  }
}
