import type { TaskResult } from "./schema.js";
import { taskPayloadErrors } from "./validate.js";

/**
 * The task contract: what a knight reads off its task stream. Dispatchers differ in
 * shape (the operator's camelCase TaskPayload, snake_case nats_request payloads from
 * other knights, plain text), so the parser accepts all of them. The wire shape is the
 * `TaskPayload` schema in ./schema.ts.
 */
export interface ParsedTask {
  task: string;
  taskId: string;
  domain?: string;
  from?: string;
  dispatchedBy?: string;
  timestamp?: string;
  /** Per-task timeout from `metadata.timeout_ms` / `metadata.timeoutMs`; only positive finite values. */
  timeoutMs?: number;
  /** Chain run identity (operator-assigned UUID). Used to start a fresh agent session
   *  per run and avoid cross-run context bleed. Absent for ad-hoc tasks. (#31) */
  runId?: string;
  /** Chain / step names from the operator's TaskPayload (activity events, introspection). */
  chainName?: string;
  stepName?: string;
  /** Optional per-task model override; applies to this task only. */
  model?: string;
  /** Epoch ms the task was published, from `timestamp` when it parses (queuedFor in task.started). */
  publishedAtMs?: number;
  /** 1-based attempt number from a manual retry (absent means 1). */
  attempt?: number;
  /** The task ID a manual retry re-runs. */
  retryOf?: string;
  /** Why the earlier attempt failed (manual retry), capped at 2 KB. */
  previousFailure?: string;
  /**
   * Set when a JSON payload does not match the TaskPayload schema: one `<field>: <problem>`
   * line per error, joined with "; ". The task must not run; answer it with a failure
   * result naming the field. `taskId` is still resolved so the result can be addressed.
   */
  invalid?: string;
}

/**
 * Normalize a task-metadata timeout to a positive, finite millisecond value, or undefined.
 *
 * A non-positive timeout (e.g. a dispatcher that marshals an omitted int field as 0) must not
 * be honored — `setTimeout(abort, 0)` cancels the task before any work happens, looking like a
 * model failure. Returning undefined lets the caller's `?? config.taskTimeoutMs` fallback win. (#30)
 */
export function normalizeTimeoutMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Accept only a non-empty string run id; anything else means "no run identity". */
function normalizeRunId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

const str = (...values: unknown[]): string | undefined => {
  const v = values.find((x) => x !== undefined && x !== null);
  return typeof v === "string" ? v : undefined;
};

/**
 * Parse a raw task message. Accepts the operator's TaskPayload (`taskId`, `runId`,
 * `chainName`, `stepName`, `task`), knight nats_request payloads (`task_id`,
 * `dispatched_by`, `metadata.timeout_ms`) and other snake_case variants. Non-JSON
 * payloads, and JSON that is not an object, are treated as plain task text.
 *
 * A JSON object is checked against the TaskPayload schema first; when it does not match,
 * the result carries `invalid` (and only the fields that could be read safely), so the
 * caller answers with a failure result instead of running, or crashing on, a bad task.
 */
export function parseTask(raw: string, subjectTaskId: string): ParsedTask {
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch {
    json = undefined;
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { task: raw, taskId: subjectTaskId };
  }
  const taskId = str(json.task_id, json.taskId) || subjectTaskId;
  const errors = taskPayloadErrors(json);
  if (errors.length) {
    return { task: "", taskId, invalid: errors.join("; "), from: str(json.from, json.payload?.from) };
  }
  const publishedAtMs = Date.parse(json.timestamp);
  return {
    task: json.task ?? json.description ?? json.message,
    taskId,
    domain: json.domain,
    from: json.from ?? json.payload?.from,
    dispatchedBy: json.dispatched_by ?? json.dispatchedBy,
    timestamp: json.timestamp,
    timeoutMs: normalizeTimeoutMs(json.metadata?.timeout_ms ?? json.metadata?.timeoutMs),
    runId: normalizeRunId(json.runId ?? json.run_id),
    chainName: str(json.chainName, json.chain_name, json.chain),
    stepName: str(json.stepName, json.step_name, json.step),
    model: typeof json.model === "string" && json.model.trim() ? json.model.trim() : undefined,
    publishedAtMs: Number.isFinite(publishedAtMs) ? publishedAtMs : undefined,
    attempt: json.attempt,
    retryOf: json.retryOf || undefined,
    previousFailure: normalizePreviousFailure(json.previousFailure),
  };
}

const MAX_PREVIOUS_FAILURE = 2048;
/** Cap on the task text echoed in a failure result. */
export const MAX_ECHOED_TASK_BYTES = 64 * 1024;

function normalizePreviousFailure(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? capBytes(value, MAX_PREVIOUS_FAILURE) : undefined;
}

/** Cut text to at most `maxBytes` of UTF-8 without leaving a broken character at the end. */
function capBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

/**
 * The prompt to run: for a manual retry (`attempt` > 1) the task text is prefixed with a
 * request to check what the earlier attempt already did. Other tasks are unchanged.
 */
export function promptWithRetryContext(task: Pick<ParsedTask, "task" | "attempt" | "retryOf" | "previousFailure">): string {
  if (!task.attempt || task.attempt <= 1) return task.task;
  const outcome = task.previousFailure ?? "unknown";
  // A fence longer than any backtick run in the text, so the text cannot close it.
  const fence = "`".repeat(Math.max(3, ...[...outcome.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return (
    `This is attempt ${task.attempt} of a task that did not finish before ` +
    `(original task \`${task.retryOf ?? "unknown"}\`; previous outcome in the block below).\n\n${fence}\n${outcome}\n${fence}\n\n` +
    "Before doing anything, check what the earlier attempt already did (files, branches, pull requests, messages, notes) " +
    `and continue from there instead of repeating it.\n\n${task.task}`
  );
}

function formatLimit(timeoutMs: number): string {
  // Round to whole seconds first, so 59.999 s reads "1 minute" rather than "60 seconds".
  const seconds = Math.max(1, Math.round(timeoutMs / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
  if (h === 0) return plural(m, "minute");
  return m === 0 ? plural(h, "hour") : `${plural(h, "hour")} ${plural(m, "minute")}`;
}

/** A note telling the model how long the task has and when it stops (UTC `HH:MM`). */
export function taskLimitNote(timeoutMs: number, startedAtMs: number): string {
  const stop = new Date(startedAtMs + timeoutMs).toISOString().slice(11, 16);
  return (
    `Time limit for this task: ${formatLimit(timeoutMs)}, stopping at ${stop} UTC (check with \`date -u\`). ` +
    "Plan for it: run the full test suite at most once, near the end; while iterating run only the tests for the code you changed; " +
    "commit and push a work-in-progress branch early so a timeout does not lose the work."
  );
}

/** The prompt with the time-limit note appended, unless `KNIGHT_TASK_LIMIT_NOTE=off`. */
export function withTaskLimitNote(
  prompt: string,
  timeoutMs: number,
  startedAtMs: number,
  env: Record<string, string | undefined> = process.env,
): string {
  if ((env.KNIGHT_TASK_LIMIT_NOTE ?? "").trim().toLowerCase() === "off") return prompt;
  return `${prompt}\n\n${taskLimitNote(timeoutMs, startedAtMs)}`;
}

/**
 * Fields a result carries for a task: `attempt` and `retry_of` when set, and on a failure
 * the original task as `task` (the dead-letter capture reads it from there, because the
 * task message is acked and gone by then).
 */
export function taskResultFields(
  parsed: ParsedTask | undefined,
  success: boolean,
): Pick<TaskResult, "attempt" | "retry_of" | "task"> {
  if (!parsed) return {};
  return {
    ...(parsed.attempt ? { attempt: parsed.attempt } : {}),
    ...(parsed.retryOf ? { retry_of: parsed.retryOf } : {}),
    ...(success
      ? {}
      : {
          task: {
            taskId: parsed.taskId,
            task: capBytes(parsed.task ?? "", MAX_ECHOED_TASK_BYTES),
            ...(parsed.runId ? { runId: parsed.runId } : {}),
            ...(parsed.chainName ? { chainName: parsed.chainName } : {}),
            ...(parsed.stepName ? { stepName: parsed.stepName } : {}),
            ...(parsed.model ? { model: parsed.model } : {}),
            ...(parsed.attempt ? { attempt: parsed.attempt } : {}),
          },
        }),
  };
}
