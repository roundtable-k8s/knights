import type { TransientReason } from "./schema.js";

/** Result fields that mark a failure as a transient provider error. */
export interface TransientFailure {
  transient: true;
  transientReason: TransientReason;
}

/** NATS client errors (and their text) are never provider errors, even when they say "connection error". */
const NATS_ERROR = /\bnats\b|jetstream|\bCONNECTION_(?:CLOSED|DRAINING|TIMEOUT|REFUSED)\b|\bNO_RESPONDERS\b/i;
/** An HTTP status is only a status when it sits next to a provider-error cue, not in unrelated text. */
const status = (codes: string) =>
  new RegExp(`(?:^\\s*|\\b(?:API Error|status(?: code)?|HTTP)\\b[:=\\s(]{0,4})(?:${codes})\\b|\\b(?:${codes})\\s+(?:overloaded|service unavailable|bad gateway|gateway time-?out|internal server error)`, "i");

/**
 * Classify the text of a model-provider failure (HTTP status or socket error, after the
 * runtime's own retries). Returns undefined for anything else, so a task that failed on
 * its own terms (tests, tool errors, its own task timeout) is never marked transient.
 * Callers pass only provider/API error text, never agent output. Patterns are anchored to
 * provider error shapes (a status next to "API Error"/"HTTP"/"status", or at the start of
 * the text), and NATS client errors are rejected, so a NATS `connection error` or a stray
 * `529` in unrelated text is not transient.
 */
export function transientFailure(text: string | undefined): TransientFailure | undefined {
  if (!text || NATS_ERROR.test(text)) return undefined;
  if (status("529").test(text) || /\boverloaded_error\b|\bAPI Error:?\s*overloaded\b/i.test(text)) return { transient: true, transientReason: "overloaded" };
  if (status("50[0234]").test(text)) return { transient: true, transientReason: "provider_5xx" };
  if (/\b(?:ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT)\b|socket hang up|connection (?:was )?reset|\bfetch failed\b|API Error:?[^\n]*connection error|\bAPIConnection(?:Timeout)?Error\b|API Error:?[^\n]*request timed out/i.test(text)) {
    return { transient: true, transientReason: "network" };
  }
  return undefined;
}
