/** Leading sentence of the generic failure; consumers match on it, so it never changes. */
export const NO_DELIVERABLE_MESSAGE = "Agent produced no deliverable output";

export interface NoDeliverableFacts {
  /** Assistant turns the task took, when known. */
  turns?: number;
  /** Tool calls the task made, when known. */
  toolCalls?: number;
  /** How the session ended, e.g. "the last message had only tool calls". Counts and reasons only, never content. */
  ended?: string;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The generic "no deliverable" error, with what the session did and a next step, so a reader
 * of the dead letter without log access can act. Never pass message content or tool arguments.
 */
export function describeNoDeliverable(facts: NoDeliverableFacts = {}): string {
  const parts: string[] = [];
  if (facts.turns !== undefined) parts.push(plural(facts.turns, "turn"));
  if (facts.toolCalls !== undefined) parts.push(plural(facts.toolCalls, "tool call"));
  let detail = parts.join(", ");
  if (facts.ended) detail = detail ? `${detail}; ${facts.ended}` : facts.ended;
  if (!detail) return NO_DELIVERABLE_MESSAGE;
  return `${NO_DELIVERABLE_MESSAGE} (${detail}). End the task with a written answer.`;
}
