/**
 * Golden fixtures in `packages/core/contract/fixtures/`, for tests in the core and in
 * each runtime (`@roundtable/knight-core/contract/fixtures`). Not part of the main export.
 */
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { taskResultErrors } from "./validate.js";

/** From dist/contract/ or src/contract/ alike. */
const FIXTURES_DIR = new URL("../../contract/fixtures/", import.meta.url);

export const TASK_FIXTURES = ["task.minimal", "task.full"] as const;
export const RESULT_FIXTURES = [
  "result.success",
  "result.failure",
  "result.lost",
  "result.refused-credits",
  "result.refused-quota",
  "result.structured",
] as const;
export const ACTIVITY_FIXTURES = [
  "activity.task.started",
  "activity.task.heartbeat",
  "activity.tool.started",
  "activity.tool.finished",
  "activity.assistant.message",
  "activity.task.finished",
] as const;

export type FixtureName = (typeof TASK_FIXTURES)[number] | (typeof RESULT_FIXTURES)[number] | (typeof ACTIVITY_FIXTURES)[number];

/** Raw fixture text, as committed. */
export function readFixtureText(name: FixtureName): string {
  return readFileSync(new URL(`${name}.json`, FIXTURES_DIR), "utf8");
}

export function readFixture<T = Record<string, unknown>>(name: FixtureName): T {
  return JSON.parse(readFixtureText(name)) as T;
}

/**
 * Result fields only one runtime sends (pi-knight `tool_calls`; claude-knight `turns`,
 * `runtime`, `billing`). The result fixtures hold the shared contract fields only.
 */
export const RUNTIME_RESULT_FIELDS = ["tool_calls", "turns", "runtime", "billing"] as const;

/**
 * How a runtime's result payload differs from a result fixture; empty when it matches.
 * The payload must be a valid TaskResult and carry exactly the fixture's fields with the
 * same values, apart from its runtime-only fields and extra token counters (cacheRead,
 * cacheWrite) that the fixture leaves out.
 */
export function resultFixtureDiff(actual: unknown, name: (typeof RESULT_FIXTURES)[number]): string[] {
  const out = taskResultErrors(actual).map((e) => `schema: ${e}`);
  if (!actual || typeof actual !== "object") return out;
  const a = actual as Record<string, unknown>;
  const f = readFixture(name);
  const runtimeOnly = new Set<string>(RUNTIME_RESULT_FIELDS);
  const keys = new Set([...Object.keys(a).filter((k) => !runtimeOnly.has(k)), ...Object.keys(f)]);
  for (const k of keys) {
    if (!(k in f)) out.push(`${k}: not in ${name}`);
    else if (!(k in a)) out.push(`${k}: missing`);
    else if (k === "tokens") {
      const at = a.tokens as Record<string, unknown>;
      for (const [tk, tv] of Object.entries(f.tokens as Record<string, unknown>)) {
        if (at?.[tk] !== tv) out.push(`tokens.${tk}: ${JSON.stringify(at?.[tk])} != ${JSON.stringify(tv)}`);
      }
    } else if (!isDeepStrictEqual(a[k], f[k])) out.push(`${k}: ${JSON.stringify(a[k])} != ${JSON.stringify(f[k])}`);
  }
  return out;
}
