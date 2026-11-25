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
  parsed?: ParsedTask;
}): TaskResult {
  return failureResult({ ...meta, error: `Invalid task payload: ${meta.invalid}` });
}
