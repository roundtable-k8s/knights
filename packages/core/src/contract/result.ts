/**
 * The task result a knight publishes to `<resultsPrefix>.<taskId>`. This is the wire
 * shape (snake_case), not a runtime's internal result type. Optional fields are only
 * present when set, so the payload stays additive.
 *
 * The two runtimes still report refusals differently (pi-knight `refused: "credits"`,
 * claude-knight `usage_limited: true`); both are kept as-is here. Unifying them is #6.
 */
export interface TaskResultPR {
  repo?: string;
  number?: number;
  url?: string;
  action?: "opened" | "updated";
}

export interface TaskResult {
  task_id: string;
  knight: string;
  success: boolean;
  result: string;
  /** Set when success is false. */
  error?: string;
  duration_ms: number;
  cost: number;
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  model: string;
  /** pi-knight: tool calls the agent made. */
  tool_calls?: number;
  /** claude-knight: agent turns. */
  turns?: number;
  /** claude-knight: "claude-knight". */
  runtime?: string;
  /** claude-knight: "subscription" | "api". */
  billing?: string;
  /** Pull requests the task opened or updated (omitted when none). */
  prs?: TaskResultPR[];
  /** Review verdict from a final `Verdict:` line (omitted when none). */
  verdict?: "ship_it" | "needs_changes";
  /** pi-knight refusal: the provider refused for affordability (e.g. OpenRouter 402). */
  refused?: "credits";
  /** claude-knight refusal: plan/credit limit reached or plan reserve hit. */
  usage_limited?: boolean;
  /** The task was delivered to a knight that stopped before finishing it (max_deliver=1). */
  lost?: boolean;
  timestamp: string;
}

/** Serialise a result exactly as it goes on the wire. */
export function encodeResult(result: TaskResult): string {
  return JSON.stringify(result);
}
