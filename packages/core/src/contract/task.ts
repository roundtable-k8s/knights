/**
 * The task contract: what a knight reads off its task stream. Dispatchers differ in
 * shape (the operator's camelCase TaskPayload, snake_case nats_request payloads from
 * other knights, plain text), so the parser accepts all of them.
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
  const publishedAtMs = Date.parse(json.timestamp);
  return {
    task: json.task ?? json.description ?? json.message ?? raw,
    taskId: json.task_id ?? json.taskId ?? subjectTaskId,
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
  };
}
