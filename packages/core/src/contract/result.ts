import type { TaskResult } from "./schema.js";
import { taskResultFields, type ParsedTask } from "./task.js";

/** Serialise a result exactly as it goes on the wire (the TaskResult schema in ./schema.ts). */
export function encodeResult(result: TaskResult): string {
  return JSON.stringify(result);
}

/** Failure message of a task that was delivered to a knight that stopped before finishing it. */
export const LOST_TASK_ERROR =
  "Task was delivered to a knight that stopped before finishing it (not re-run: max_deliver=1)";

/**
 * The common part of a failure result that did not come out of a task run (lost task,
 * invalid payload). Runtimes add their own fields (claude-knight `runtime`, `billing`).
 */
export function failureResult(meta: {
  taskId: string;
  knight: string;
  model: string;
  error: string;
  timestamp?: string;
  /** The parsed task; echoed on the failure result as `task` (with `attempt`, `retry_of`). */
  parsed?: ParsedTask;
}): TaskResult {
  return {
    ...taskResultFields(meta.parsed, false),
    task_id: meta.taskId,
    knight: meta.knight,
    success: false,
    result: `Task failed: ${meta.error}`,
    error: meta.error,
    duration_ms: 0,
    cost: 0,
    tokens: { input: 0, output: 0 },
    model: meta.model,
    timestamp: meta.timestamp ?? new Date().toISOString(),
  };
}

/** Result for a task that was delivered but never acked (`lost: true`). */
export function lostTaskResult(meta: {
  taskId: string;
  knight: string;
  model: string;
  timestamp?: string;
  parsed?: ParsedTask;
}): TaskResult {
  return { ...failureResult({ ...meta, error: LOST_TASK_ERROR }), lost: true };
}

/** Result for a task whose payload did not match the TaskPayload schema. */
export function invalidTaskResult(meta: {
  taskId: string;
  knight: string;
  model: string;
  invalid: string;
  timestamp?: string;
}): TaskResult {
  return failureResult({ ...meta, error: `Invalid task payload: ${meta.invalid}` });
}

/** Default cap on the result text (RESULT_MAX_BYTES): 512 KB. */
export const RESULT_MAX_BYTES = 512 * 1024;

/**
 * Cap `result.result` to `maxBytes` of UTF-8. Over the budget, the head and the tail are kept
 * (a trailing `Verdict:` line or PR URL survives) with a `[... N bytes omitted ...]` line between
 * them, and `result_truncated: true` is set. A result within the budget is returned as is.
 * Cuts never fall inside a multi-byte character.
 */
export function capResultText(result: TaskResult, maxBytes: number): TaskResult {
  const buf = Buffer.from(result.result, "utf8");
  if (buf.length <= maxBytes) return result;

  const markerRoom = Buffer.byteLength(`\n[... ${buf.length} bytes omitted ...]\n`);
  if (maxBytes < markerRoom) {
    // No room for the marker line: keep a plain UTF-8-safe prefix so the budget still holds.
    let end = Math.max(0, maxBytes);
    while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
    return { ...result, result: buf.subarray(0, end).toString("utf8"), result_truncated: true };
  }
  const keep = maxBytes - markerRoom;
  let headEnd = Math.floor(keep * 0.6);
  let tailStart = buf.length - (keep - headEnd);
  // Move off UTF-8 continuation bytes (10xxxxxx) so no character is split.
  while (headEnd > 0 && (buf[headEnd]! & 0xc0) === 0x80) headEnd--;
  while (tailStart < buf.length && (buf[tailStart]! & 0xc0) === 0x80) tailStart++;

  const omitted = tailStart - headEnd;
  const text =
    buf.subarray(0, headEnd).toString("utf8") +
    `\n[... ${omitted} bytes omitted ...]\n` +
    buf.subarray(tailStart).toString("utf8");
  return { ...result, result: text, result_truncated: true };
}
