/**
 * The knight task contract, defined once (roundtable-k8s/knights#6).
 *
 * TypeBox schemas for what a knight reads off its task stream (`TaskPayload`), what it
 * publishes back (`TaskResult`) and the live activity events it emits (`ActivityEvent`,
 * v1). The TypeScript types come from `Static<>`; `npm run contract:export` writes the
 * same definitions as JSON Schema 2020-12 to `packages/core/contract/`, which the
 * operator (roundtable-k8s/roundtable#431) and the golden fixtures are checked against.
 *
 * Descriptions follow roundtable `docs/knight-task-contract.md`.
 */
import { Type, type Static } from "typebox";

const SCHEMA_BASE = "https://roundtable.io/schemas";

// ── Task payload ────────────────────────────────────────────────────

const str = (description: string, extra: Record<string, unknown> = {}) =>
  Type.Optional(Type.String({ description, ...extra }));

export const TaskPayload = Type.Object(
  {
    taskId: str("Unique task ID (operator TaskPayload). The result is published to `<prefix>.results.<taskId>`."),
    task_id: str("Unique task ID, snake_case spelling (knight `nats_request` payloads). Falls back to the last subject token when neither spelling is set."),
    task: str("The rendered prompt."),
    description: str("Legacy alias for `task`.", { deprecated: true }),
    message: str("Legacy alias for `task`.", { deprecated: true }),
    chainName: str("Chain name; set for chain steps and mission briefings."),
    chain_name: str("snake_case alias for `chainName`."),
    chain: str("Short alias for `chainName`."),
    stepName: str("Chain step name; set for chain steps and mission briefings."),
    step_name: str("snake_case alias for `stepName`."),
    step: str("Short alias for `stepName`."),
    runId: str(
      "Chain run ID, or for gateway tasks the conversation ID. Knights key agent sessions on it so context never bleeds between runs. Empty means no run identity.",
    ),
    run_id: str("snake_case alias for `runId`."),
    model: str(
      "Per-task model override, already resolved from RoundTable aliases and checked against the knight's runtime. Applies to this task only; empty means the knight's configured model.",
    ),
    attempt: Type.Optional(
      Type.Integer({ minimum: 1, description: "1-based attempt number, set by a manual retry. Absent means attempt 1." }),
    ),
    retryOf: str("The task ID this task retries (manual retry)."),
    previousFailure: str("Why the earlier attempt failed or was lost (manual retry; up to 2 KB, longer values are cut)."),
    domain: str("Task domain the dispatcher routed on."),
    from: str("Knight that sent the task; a knight skips tasks it sent itself."),
    dispatched_by: str("Who dispatched the task (knight `nats_request` payloads)."),
    dispatchedBy: str("camelCase alias for `dispatched_by`."),
    timestamp: str("When the task was published (RFC 3339). Used for queue time; an unparseable value is ignored."),
    metadata: Type.Optional(
      Type.Object(
        {
          timeout_ms: Type.Optional(
            Type.Number({ description: "Per-task timeout in ms. Zero or negative means unset (the knight default applies)." }),
          ),
          timeoutMs: Type.Optional(Type.Number({ description: "camelCase alias for `timeout_ms`." })),
        },
        { description: "Dispatcher metadata." },
      ),
    ),
    payload: Type.Optional(
      Type.Object({ from: str("Legacy location of `from`.") }, { description: "Legacy envelope." }),
    ),
  },
  {
    $id: `${SCHEMA_BASE}/knight-task.v1.json`,
    title: "TaskPayload",
    description:
      "A task on `<prefix>.tasks.<domain>.<knight>`. Dispatchers differ in shape (the operator's camelCase TaskPayload, snake_case knight `nats_request` payloads), so both spellings are accepted. A message that is not a JSON object is plain task text and is not checked against this schema.",
    // The prompt is required under one of its names.
    anyOf: [{ required: ["task"] }, { required: ["description"] }, { required: ["message"] }],
  },
);
export type TaskPayload = Static<typeof TaskPayload>;

// ── Task result ─────────────────────────────────────────────────────

export const TaskResultPR = Type.Object(
  {
    repo: Type.Optional(Type.String({ description: "`owner/repo`." })),
    number: Type.Optional(Type.Integer({ minimum: 1 })),
    url: Type.Optional(Type.String()),
    action: Type.Optional(Type.Enum(["opened", "updated"])),
  },
  { description: "A pull request the task opened or updated." },
);
export type TaskResultPR = Static<typeof TaskResultPR>;

export const Refusal = Type.Enum(["credits", "quota"], {
  description:
    "Machine-readable refusal: the task did not run for affordability. `credits`: the provider is out of credits (e.g. OpenRouter 402), which does not reset on its own, so escalate. `quota`: a plan quota window is used up (claude-knight subscription), which resets later, so defer and re-run.",
});
export type Refusal = Static<typeof Refusal>;

export const TransientReason = Type.Enum(["overloaded", "provider_5xx", "network"], {
  description:
    "Why a transient failure happened. `overloaded`: the provider answered HTTP 529. `provider_5xx`: it answered 500, 502, 503 or 504. `network`: a connection reset or timeout to the provider.",
});
export type TransientReason = Static<typeof TransientReason>;

const count = (description: string) => Type.Number({ minimum: 0, description });

export const TaskResult = Type.Object(
  {
    task_id: Type.String({ description: "Echo of the task ID." }),
    knight: Type.String({ description: "The knight that ran the task." }),
    success: Type.Boolean({ description: "False when the task produced no deliverable; `error` then says why." }),
    result: Type.String({ description: "Task output, or the failure message when `success` is false." }),
    result_truncated: Type.Optional(
      Type.Boolean({
        description:
          "The `result` text was cut to fit the NATS payload limit (RESULT_MAX_BYTES): the head and the tail are kept with a `[... N bytes omitted ...]` line between them. Absent when the text is whole.",
      }),
    ),
    error: Type.Optional(Type.String({ description: "Set when `success` is false." })),
    duration_ms: count("Wall-clock run time in ms."),
    cost: count("USD. claude-knight in subscription mode reports the API-equivalent cost, not billed."),
    tokens: Type.Object({
      input: count("Input tokens."),
      output: count("Output tokens."),
      cacheRead: Type.Optional(count("Cached input tokens read.")),
      cacheWrite: Type.Optional(count("Cached input tokens written.")),
    }),
    model: Type.String({ description: "The model actually used, whether or not the task carried an override." }),
    tool_calls: Type.Optional(count("Tool calls the agent made (pi-knight and claude-knight).")),
    turns: Type.Optional(count("claude-knight: agent turns.")),
    runtime: Type.Optional(Type.String({ description: "claude-knight: `claude-knight`." })),
    billing: Type.Optional(Type.Enum(["subscription", "api", "local"], {
        description: "How the run is billed. claude-knight: `subscription` or `api`. pi-knight: `local` for an operator-supplied model endpoint (cost 0).",
      })),
    prs: Type.Optional(
      Type.Array(TaskResultPR, { description: "Pull requests the task opened or updated (omitted when none)." }),
    ),
    verdict: Type.Optional(
      Type.Enum(["ship_it", "needs_changes"], { description: "Review verdict from a final `Verdict:` line (omitted when none)." }),
    ),
    refused: Type.Optional(Refusal),
    transient: Type.Optional(
      Type.Boolean({
        description:
          "The task failed because the model provider was briefly unavailable, after the runtime's own retries. Safe to retry later. Never set for a task that failed on its own terms or was refused.",
      }),
    ),
    transientReason: Type.Optional(TransientReason),
    usage_limited: Type.Optional(
      Type.Boolean({
        deprecated: true,
        description:
          "Deprecated: use `refused: \"quota\"`. claude-knight still sends it alongside `refused` until the operator reads `refused` (roundtable-k8s/roundtable#431).",
      }),
    ),
    lost: Type.Optional(
      Type.Boolean({ description: "The task was delivered to a knight that stopped before finishing it (max_deliver=1); it was not re-run." }),
    ),
    attempt: Type.Optional(Type.Integer({ minimum: 1, description: "Echo of the task's attempt number (set only on a manual retry)." })),
    retry_of: Type.Optional(Type.String({ description: "Echo of the task's `retryOf` (set only on a manual retry)." })),
    task: Type.Optional(
      Type.Object(
        {
          taskId: Type.String(),
          task: Type.String({ description: "The task text, capped at 64 KB." }),
          runId: Type.Optional(Type.String()),
          chainName: Type.Optional(Type.String()),
          stepName: Type.Optional(Type.String()),
          model: Type.Optional(Type.String()),
          attempt: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { description: "The original task, on failure results only (`success: false`, including `lost`), so the operator can dead-letter and retry it." },
      ),
    ),
    timestamp: Type.String({ format: "date-time", description: "When the result was published." }),
  },
  {
    $id: `${SCHEMA_BASE}/knight-task-result.v1.json`,
    title: "TaskResult",
    description:
      "What a knight publishes to `<prefix>.results.<taskId>`. Optional fields are only present when set, so the payload stays additive; consumers ignore fields they do not know.",
  },
);
export type TaskResult = Static<typeof TaskResult>;

// ── Activity events (v1) ────────────────────────────────────────────

export const ACTIVITY_TYPES = [
  "task.started",
  "task.heartbeat",
  "tool.started",
  "tool.finished",
  "assistant.message",
  "task.finished",
] as const;

const nonNegInt = Type.Integer({ minimum: 0 });

/**
 * Mirrors roundtable `docs/design/task-activity-events.schema.json` field for field;
 * a test keeps the two equivalent.
 */
export const ActivityEvent = Type.Object(
  {
    v: Type.Unsafe<1>({ const: 1 }),
    type: Type.Enum([...ACTIVITY_TYPES]),
    ts: Type.String({ format: "date-time" }),
    knight: Type.String(),
    table: Type.Optional(Type.String()),
    pod: Type.String(),
    node: Type.Optional(Type.String()),
    taskId: Type.String(),
    runId: Type.Optional(Type.String()),
    chainName: Type.Optional(Type.String()),
    stepName: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    seq: Type.Integer({ minimum: 1 }),
    truncated: Type.Optional(Type.Boolean()),
    slot: Type.Optional(nonNegInt),
    concurrency: Type.Optional(Type.Integer({ minimum: 1 })),
    queuedFor: Type.Optional(nonNegInt),
    attempt: Type.Optional(Type.Integer({ minimum: 1 })),
    turns: Type.Optional(nonNegInt),
    inputTokens: Type.Optional(nonNegInt),
    outputTokens: Type.Optional(nonNegInt),
    costUsd: Type.Optional(Type.Number({ minimum: 0 })),
    currentTool: Type.Optional(Type.String()),
    tool: Type.Optional(Type.String()),
    toolCallId: Type.Optional(Type.String()),
    argsSummary: Type.Optional(Type.String({ maxLength: 200 })),
    durationMs: Type.Optional(nonNegInt),
    isError: Type.Optional(Type.Boolean()),
    outputPreview: Type.Optional(Type.String({ maxLength: 500 })),
    preview: Type.Optional(Type.String({ maxLength: 500 })),
    success: Type.Optional(Type.Boolean()),
    errorClass: Type.Optional(Type.String()),
  },
  {
    $id: `${SCHEMA_BASE}/task-activity-event.v1.json`,
    title: "TaskActivityEvent",
    description:
      "A live, fire-and-forget event on core NATS `<prefix>.activity.<Knight>.<taskId>` (roundtable-k8s/roundtable#249). Never stored; at most 8 KiB.",
    additionalProperties: true,
  },
);
export type ActivityEvent = Static<typeof ActivityEvent>;
