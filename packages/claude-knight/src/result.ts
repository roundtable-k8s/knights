/**
 * Turn what a Claude Code run produced into the knight result the operator and
 * other knights read. Same honesty rule as pi-knight (#31): no deliverable means
 * success=false with the real reason, never a sentinel string marked success.
 */
import { USAGE_LIMIT_ERROR_PREFIXES, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { KnightConfig } from "./config.js";
import { ShutdownAbort, invalidTaskResult, log, lostTaskResult, parseTaskFailure, parseVerdict, resolvePrs, taskResultFields, transientFailure, type TransientFailure, type ParsedTask, type PRRef, type TaskResult as ResultPayload, type Verdict } from "@roundtable/knight-core";

export interface TaskResult {
  result: string;
  success: boolean;
  error?: string;
  /** USD at API list prices. In subscription mode this is API-equivalent, not billed. */
  cost: number;
  billing: "subscription" | "api";
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  model: string;
  /** Agent turns. */
  turns: number;
  /** Tool calls the agent made (0 when none). */
  toolCalls?: number;
  /** True when the failure was a plan/credit limit, so callers can back off. Published as `refused: "quota"`. */
  usageLimited?: boolean;
  /** Set when the final failure was a transient provider error (HTTP 529/5xx, connection reset or timeout). */
  transient?: TransientFailure;
  /** Pull requests the task opened or updated (omitted when none). */
  prs?: PRRef[];
  /** Review outcome from a final `Verdict:` line (omitted when none). */
  verdict?: Verdict;
}

export interface ClassifyInput {
  result: SDKResultMessage | undefined;
  lastAssistantText: string;
  assistantError?: string;
  thrown?: string;
  aborted: boolean;
  /** `signal.reason` of the abort; a ShutdownAbort marks an interruption by knight shutdown. */
  abortReason?: unknown;
  config: KnightConfig;
  durationMs: number;
  /** PRs found from the agent's gh/git commands (StreamState.prs). */
  prs?: PRRef[];
  /** Tool calls seen in the stream (StreamState.toolCalls). */
  toolCalls?: number;
  /** Background tasks still live at the end of the stream (StreamState.backgroundTasks). */
  backgroundTasks?: ReadonlyMap<string, { description: string }>;
}

/** The final line added to a successful result when background jobs were cut off with the turn. */
export function backgroundJobsNote(tasks: ReadonlyMap<string, { description: string }>): string {
  const cut = (d: string) => (d.length > 80 ? `${d.slice(0, 77)}...` : d);
  const descriptions = [...tasks.values()].map((t) => cut(t.description)).join("; ");
  return `Note: ${tasks.size} background job(s) were still running when this turn ended and were stopped: ${descriptions}. Their output is not in this result.`;
}

export function isUsageLimitMessage(text: string | undefined): boolean {
  if (!text) return false;
  return USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.trim().startsWith(p));
}

/** Pick the model that did most of the work, by output tokens. */
function primaryModel(result: SDKResultMessage | undefined, fallback: string): string {
  const usage = result?.modelUsage;
  if (!usage) return fallback;
  let best: string | undefined;
  let bestOut = -1;
  for (const [model, u] of Object.entries(usage)) {
    if (u.outputTokens > bestOut) {
      best = model;
      bestOut = u.outputTokens;
    }
  }
  return best ?? fallback;
}

const DEFAULT_MODEL = "claude-code-default";

/** The model a result reports: the configured Claude model, or Claude Code's default. */
export function resultModel(config: Pick<KnightConfig, "claudeModel">): string {
  return config.claudeModel ?? DEFAULT_MODEL;
}

const safe = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0);

export function classifyResult(input: ClassifyInput): TaskResult {
  const { result, lastAssistantText, assistantError, thrown, aborted, abortReason, config } = input;
  const usage = result?.usage;
  const base = {
    cost: safe(result?.total_cost_usd),
    billing: config.authMode,
    tokens: {
      input: safe(usage?.input_tokens),
      output: safe(usage?.output_tokens),
      cacheRead: safe(usage?.cache_read_input_tokens),
      cacheWrite: safe(usage?.cache_creation_input_tokens),
    },
    model: primaryModel(result, resultModel(config)),
    turns: result?.num_turns ?? 0,
    ...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
  } satisfies Omit<TaskResult, "result" | "success">;

  const fail = (error: string, extra: Partial<TaskResult> = {}): TaskResult => ({
    ...base,
    result: error,
    success: false,
    error,
    ...extra,
  });

  // Success path: a result message that is not an error, with real text.
  if (result && result.subtype === "success" && !result.is_error) {
    const text = (result.result ?? "").trim() || lastAssistantText;
    if (text) {
      const declared = parseTaskFailure(text);
      if (declared) return fail(declared, { result: text });
      const prs = resolvePrs(input.prs ?? [], text);
      const verdict = parseVerdict(text);
      const pending = input.backgroundTasks;
      let finalText = text;
      if (pending?.size) {
        log.warn("Turn ended with background jobs still running", { taskIds: [...pending.keys()] });
        finalText = `${text}\n\n${backgroundJobsNote(pending)}`;
      }
      return { ...base, result: finalText, success: true, ...(prs.length ? { prs } : {}), ...(verdict ? { verdict } : {}) };
    }
    return fail("Agent produced no deliverable output");
  }

  // Failure paths, most specific first.
  const resultText = result && "result" in result ? String(result.result ?? "") : "";
  const errors = result && "errors" in result && Array.isArray(result.errors) ? result.errors.join("; ") : "";
  const candidates = [resultText, errors, thrown, lastAssistantText].filter(Boolean) as string[];
  const limitText = candidates.find(isUsageLimitMessage);
  if (limitText || assistantError === "rate_limit" || assistantError === "billing_error") {
    return fail(`Claude usage limit reached: ${limitText ?? assistantError}`, { usageLimited: true });
  }
  if (assistantError === "authentication_failed" || /invalid bearer token|authentication/i.test(thrown ?? "")) {
    return fail(
      `Claude authentication failed (${assistantError ?? thrown}). Check the knight's ${
        config.authMode === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN (setup-tokens last a year)" : "ANTHROPIC_API_KEY"
      }.`,
    );
  }
  if (aborted && abortReason instanceof ShutdownAbort) {
    const msg = "Task interrupted: the knight is shutting down (pod restart or rollout), not a task timeout. It can be retried.";
    return fail(lastAssistantText ? `${msg} Partial output:\n\n${lastAssistantText}` : msg);
  }
  if (aborted) {
    return lastAssistantText
      ? fail(`Task timed out after ${Math.round(input.durationMs / 1000)}s. Partial output:\n\n${lastAssistantText}`)
      : fail("Task aborted before producing output (task timeout)");
  }
  // Provider-side failure after Claude Code's own retries. Only provider/API error text is
  // inspected, never the agent's own output, so a task that failed on its own terms is not marked.
  const providerText = [resultText, errors, thrown].filter(Boolean).join("\n");
  const transient = transientFailure(providerText) ?? (assistantError === "server_error" ? transientFailure("API Error: 500") : undefined);
  if (result) {
    switch (result.subtype) {
      case "error_max_turns":
        return fail(`Stopped at the turn limit (${result.num_turns} turns)${lastAssistantText ? `. Last output:\n\n${lastAssistantText}` : ""}`);
      case "error_max_budget_usd":
        return fail(`Stopped at the per-task budget ($${config.maxBudgetUsd})${lastAssistantText ? `. Last output:\n\n${lastAssistantText}` : ""}`);
      default:
        return fail(`Claude Code error (${result.subtype}${result.is_error ? ", is_error" : ""}): ${errors || resultText || assistantError || "no detail"}`, transient ? { transient } : {});
    }
  }
  return fail(`Claude Code failed: ${thrown ?? assistantError ?? "no result message"}`, transient ? { transient } : {});
}


/** Outcome for a task the plan reserve refused before Claude Code was started. */
export function reserveRefusedOutcome(reason: string | undefined, config: KnightConfig): TaskResult {
  const msg = `Task refused: ${reason}`;
  return {
    result: msg,
    success: false,
    error: msg,
    usageLimited: true,
    cost: 0,
    billing: config.authMode,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    model: resultModel(config),
    turns: 0,
  };
}

/** Outcome for a task that threw out of executeTask. */
export function failedOutcome(errMsg: string, config: KnightConfig): TaskResult {
  const transient = transientFailure(errMsg);
  return {
    ...(transient ? { transient } : {}),
    result: `Task failed: ${errMsg}`,
    success: false,
    error: errMsg,
    cost: 0,
    billing: config.authMode,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    model: resultModel(config),
    turns: 0,
  };
}

/** Fields every claude-knight result carries on top of the shared contract. */
export function runtimeFields(config: Pick<KnightConfig, "authMode">): Pick<ResultPayload, "runtime" | "billing"> {
  return { runtime: "claude-knight", billing: config.authMode };
}

/** Payload for a lost task (delivered, never acked), with the claude-knight runtime fields. */
export function lostResultPayload(config: KnightConfig, parsed: ParsedTask): ResultPayload {
  return {
    ...lostTaskResult({ taskId: parsed.taskId, knight: config.knightName, model: resultModel(config), parsed }),
    ...runtimeFields(config),
  };
}

/** Payload for a task whose payload broke the TaskPayload schema, with the claude-knight runtime fields. */
export function invalidResultPayload(config: KnightConfig, parsed: ParsedTask): ResultPayload {
  return {
    ...invalidTaskResult({ taskId: parsed.taskId, knight: config.knightName, model: resultModel(config), invalid: parsed.invalid ?? "invalid" }),
    ...runtimeFields(config),
  };
}

/**
 * Build the NATS task-result payload from an outcome. Optional fields are only present
 * when set. A plan/credit limit is published as `refused: "quota"` plus the deprecated
 * `usage_limited: true`, which the operator reads until it reads `refused`
 * (roundtable-k8s/roundtable#431). Pure so tests can check it against the golden fixtures.
 */
export function buildResultPayload(
  outcome: TaskResult,
  meta: { taskId: string; knight: string; durationMs: number; timestamp?: string; parsed?: ParsedTask },
): ResultPayload {
  return {
    task_id: meta.taskId,
    knight: meta.knight,
    success: outcome.success,
    result: outcome.result,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.usageLimited ? { refused: "quota" as const, usage_limited: true } : {}),
    ...(outcome.transient ? outcome.transient : {}),
    ...(outcome.prs?.length ? { prs: outcome.prs } : {}),
    ...(outcome.verdict ? { verdict: outcome.verdict } : {}),
    duration_ms: meta.durationMs,
    cost: outcome.cost,
    tokens: outcome.tokens,
    model: outcome.model,
    turns: outcome.turns,
    ...(outcome.toolCalls !== undefined ? { tool_calls: outcome.toolCalls } : {}),
    runtime: "claude-knight",
    billing: outcome.billing,
    ...taskResultFields(meta.parsed, outcome.success),
    timestamp: meta.timestamp ?? new Date().toISOString(),
  };
}
