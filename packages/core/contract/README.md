# Knight task contract

This directory is the source of truth for the messages between the Round Table operator and the knight
runtimes (pi-knight, claude-knight). The definitions live in TypeBox in
[`../src/contract/schema.ts`](../src/contract/schema.ts); everything here is generated from them or checked
against them.

| File | What |
|------|------|
| `task-payload.schema.json` | A task on `<prefix>.tasks.<domain>.<knight>` (`TaskPayload`). |
| `task-result.schema.json` | A result on `<prefix>.results.<taskId>` (`TaskResult`). |
| `task-activity-events.schema.json` | A live activity event on `<prefix>.activity.<Knight>.<taskId>` (v1). |
| `fixtures/*.json` | Golden payloads: two tasks, six results, one activity event per event type. |

The schemas are JSON Schema 2020-12. Do not edit them by hand: change `schema.ts`, then run

```bash
npm run contract:export
```

and commit the result. `npm test` fails when the committed files are stale.

## Checks

- Every fixture validates against its schema.
- Each runtime's result builder produces the result fixtures for the same inputs
  (`resultFixtureDiff` in `@roundtable/knight-core/contract/fixtures`). Result fixtures hold the shared
  fields only; runtime-specific fields (`tool_calls` — sent by pi-knight and claude-knight — `turns`, `runtime`, `billing`) and extra token counters are
  left out of the comparison.
- Both runtimes' activity events validate against the activity schema.
- `parseTask` checks every JSON task against `TaskPayload`. A task that does not match is not run: the
  knight answers with a failure result whose error names the field (`Invalid task payload: runId: must be
  string`). An empty or whitespace-only task text is answered the same way (`Invalid task payload:
  task: must not be empty`), so the dispatcher does not wait for its timeout. Text that is not a JSON
  object is still read as plain task text.
- `publishResult` checks every outgoing result against `TaskResult` under `node --test` only, never in
  production.

## Truncated results

`publishResult` caps `result` to the smaller of `RESULT_MAX_BYTES` (default 512 KB) and what the NATS
server's `max_payload` leaves after the rest of the result. Over the cap, the head and the tail are kept
with a `[... N bytes omitted ...]` line between them (so a trailing `Verdict:` line or PR URL survives),
the cut never splits a UTF-8 character, and the result carries `result_truncated: true`. `prs` and
`verdict` are read from the full text before the cut. A result within the cap is published unchanged and has
no `result_truncated` field. The size is checked on the JSON-encoded payload (quotes, newlines and control characters grow when escaped), not on the raw text. A JetStream stream's `max_msg_size` is not read from the server; if it is lower than `max_payload`, lower `RESULT_MAX_BYTES` to match. `fixtures/result.truncated.json` is an example.

## Refusals

`refused` is the one machine-readable refusal field:

| Value | Sent by | Meaning | What the caller should do |
|-------|---------|---------|---------------------------|
| `credits` | pi-knight | The provider is out of credits (e.g. OpenRouter 402). Does not reset on its own. | Escalate. |
| `quota` | claude-knight | A Claude plan window is used up, or at the knight's reserve. Resets later. | Defer and re-run. |

`usage_limited: true` is deprecated. claude-knight keeps sending it next to `refused: "quota"` until the
operator reads `refused` (roundtable-k8s/roundtable#431).

## Transient failures

`transient: true` with a `transientReason` marks a failure caused by the model provider being briefly
unavailable, after the runtime's own retries were spent. It is never set for a task that failed on its own
terms (tests, tool errors, its own task timeout) or was refused.

| `transientReason` | Meaning |
|-------------------|---------|
| `overloaded` | The provider answered HTTP 529. |
| `provider_5xx` | The provider answered 500, 502, 503 or 504. |
| `network` | A connection reset or timeout to the provider. |

## How roundtable consumes it

The operator (Go, `pkg/nats`) does not import this package. The operator side is
roundtable-k8s/roundtable#431: roundtable copies the `*.schema.json` files and the fixtures from a pinned
commit of this repo and tests its Go types (`TaskPayload`, `TaskResult`, `ActivityEvent`) against them, so a
contract change here shows up there as a failing test when the pin is bumped. `task-activity-events.schema.json` replaces roundtable's hand-written
`docs/design/task-activity-events.schema.json`; it is the same schema (`$id`, required fields, enums and
limits), which `tests/contract-schema.test.ts` checks against a copy of the roundtable file.

Changes stay additive: new optional fields only. Removing or renaming a field, or making one required, is a
breaking change that needs a coordinated rollout across the operator and both runtimes.
