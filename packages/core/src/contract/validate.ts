/**
 * Compiled checks for the contract schemas. `parseTask` uses the task check on every
 * incoming payload; the result and activity checks are for tests (publishResult asserts
 * outgoing results only under `node --test`, never in production).
 */
import { Compile } from "typebox/compile";
import { ActivityEvent, TaskPayload, TaskResult } from "./schema.js";

const taskCheck = Compile(TaskPayload);
const resultCheck = Compile(TaskResult);
const activityCheck = Compile(ActivityEvent);

interface SchemaError {
  keyword: string;
  instancePath: string;
  message: string;
  params?: Record<string, unknown>;
}

/** `/metadata/timeout_ms` → `metadata.timeout_ms`; the root is `payload`. */
function fieldName(path: string): string {
  return path ? path.replace(/^\//, "").replace(/\//g, ".") : "payload";
}

/** One line per error: `<field>: <message>`, skipping anyOf wrappers that only repeat a nested error. */
function describe(errors: Iterable<SchemaError>): string[] {
  const all = [...errors];
  const out: string[] = [];
  for (const e of all) {
    if (e.keyword === "anyOf" && all.some((o) => o !== e && o.instancePath === e.instancePath)) continue;
    let line: string;
    if (e.keyword === "required" && e.instancePath === "") {
      const missing = (e.params?.requiredProperties as string[] | undefined) ?? [];
      line = missing.length ? `${missing.join(", ")}: required` : `payload: ${e.message}`;
    } else {
      line = `${fieldName(e.instancePath)}: ${e.message}`;
    }
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

function errorsOf(check: { Check(v: unknown): boolean; Errors(v: unknown): Iterable<unknown> }, value: unknown): string[] {
  return check.Check(value) ? [] : describe(check.Errors(value) as Iterable<SchemaError>);
}

/** Errors in a task payload (a parsed JSON object); empty when it is valid. */
export function taskPayloadErrors(value: unknown): string[] {
  const errors = errorsOf(taskCheck, value);
  // The anyOf "task | description | message" reports each branch; name the canonical field once.
  if (errors.length && value && typeof value === "object" && !("task" in value) && !("description" in value) && !("message" in value)) {
    return ["task: required", ...errors.filter((e) => !/^(task|description|message): required$/.test(e))];
  }
  return errors;
}

/** Errors in a task result; empty when it is valid. */
export function taskResultErrors(value: unknown): string[] {
  return errorsOf(resultCheck, value);
}

/** Errors in an activity event; empty when it is valid. */
export function activityEventErrors(value: unknown): string[] {
  return errorsOf(activityCheck, value);
}

/** Throw when `value` is not a valid TaskResult. */
export function assertTaskResult(value: unknown): asserts value is TaskResult {
  const errors = taskResultErrors(value);
  if (errors.length) throw new Error(`Invalid task result: ${errors.join("; ")}`);
}
