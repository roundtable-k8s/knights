import type { TransientReason } from "./schema.js";

/** Result fields that mark a failure as a transient provider error. */
export interface TransientFailure {
  transient: true;
  transientReason: TransientReason;
}

/**
 * Classify the text of a model-provider failure (HTTP status or socket error, after the
 * runtime's own retries). Returns undefined for anything else, so a task that failed on
 * its own terms (tests, tool errors, its own task timeout) is never marked transient.
 * Callers pass only provider/API error text, never agent output.
 */
export function transientFailure(text: string | undefined): TransientFailure | undefined {
  if (!text) return undefined;
  if (/\b529\b|\boverloaded(_error)?\b/i.test(text)) return { transient: true, transientReason: "overloaded" };
  if (/\b(?:50[0234])\b/.test(text) && /\b(?:status|http|api error|error|unavailable|bad gateway|gateway time-?out|server error)\b/i.test(text)) {
    return { transient: true, transientReason: "provider_5xx" };
  }
  if (/\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT)\b|socket hang up|connection (?:was )?reset|\bfetch failed\b|connection error|request timed out|APIConnectionTimeoutError/i.test(text)) {
    return { transient: true, transientReason: "network" };
  }
  return undefined;
}
