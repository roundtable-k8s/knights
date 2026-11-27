# claude-knight

> This package now lives in the [roundtable-k8s/knights](https://github.com/roundtable-k8s/knights) monorepo under `packages/`.

A knight runtime for [Roundtable](https://github.com/roundtable-k8s/roundtable) that runs each task through
**Claude Code**: the official Claude Code CLI run headless (`claude -p`) on a **Claude Max/Pro plan** with a
`claude setup-token`, or the Claude Agent SDK with an API key.

It is a drop-in replacement for [pi-knight](https://github.com/roundtable-k8s/pi-knight) on a per-knight basis:
set `spec.image: ghcr.io/roundtable-k8s/claude-knight:latest` on a Knight. The operator is unchanged — same env
contract, NATS consumer, result payload, `/health` `/ready` `/metrics` `/introspect` endpoints, and the
`<prefix>.introspect.<Knight>` responder the dashboard uses. Chains, Missions and knight-to-knight
`nats_request` work across pi-knights and claude-knights.

## How it runs a task

```
NATS task ──► claude-knight ──► claude -p  (cli)  ──► Claude Code process (one per task)
                 │          └─► query()    (sdk)  ─┘   ├─ built-in tools (Bash, Read, Edit, Grep, WebFetch, Agent, Skill…)
                 │                     │               ├─ mcp__roundtable__nats_request / nats_publish / find_knights / browser_*
                 │                     │               ├─ arsenal skills (/skills → $CLAUDE_CONFIG_DIR/skills)
                 │                     │               └─ extra MCP servers (MCP_SERVERS_JSON, /config/mcp.json)
                 └─ result ◄───────────┘  (stream-json: result, usage, cost, session id, plan-limit events)
NATS result ◄──  {task_id, success, result, cost, tokens, model, turns, billing, runtime}
```

### Runtimes

`CLAUDE_RUNTIME` picks how each task reaches Claude Code. Everything Round Table-specific stays in the knight
process either way: the NATS consumer, the result payload, `runId` sessions, the plan reserve, metrics,
introspect and `/health` `/ready`.

| | `cli` (default for `subscription`) | `sdk` (default for `api`) |
|---|---|---|
| Runs | the official Claude Code CLI, `claude -p --output-format stream-json --verbose`, prompt on stdin | the Agent SDK's `query()` |
| Allowed auth | `subscription` or `api` | `api` only |
| Round Table tools | stdio MCP server `node dist/index.js mcp` (own NATS connection), from a per-task `--mcp-config` merged with `/config/mcp.json` and `MCP_SERVERS_JSON` | in-process SDK MCP server |
| Bash guardrails | `PreToolUse` command hook `node dist/index.js hook pretooluse` in a per-task `--settings` file | in-process `PreToolUse` callback |
| System prompt | `--append-system-prompt-file` | `systemPrompt.append` |
| Introspect | reads `$CLAUDE_CONFIG_DIR/projects/<cwd>/<session>.jsonl` | SDK `listSessions` / `getSessionMessages` |

`subscription` with `CLAUDE_RUNTIME=sdk` is refused at startup: the knight stays degraded (`/ready` 503 with the
reason), as with a missing credential. The image puts a pinned `claude` on `PATH`: the native binary the Agent
SDK's platform package already ships (byte-identical to `@anthropic-ai/claude-code-linux-x64` of the same
version), so there is one copy of the CLI, not two. `CLAUDE_CODE_VERSION` in the Dockerfile pins it; a version
that differs from the SDK's bundled CLI is installed on its own, and the build checks `claude --version`.

- **Sessions.** Steps of one chain run (`runId`) resume the same Claude Code session; a new run or an ad-hoc
  task starts fresh. Long-term memory lives in files on the PVC (`MEMORY.md`, `memory/`, `session-notes/`),
  as the knight contract in `defaults/AGENTS.md` asks. `CLAUDE_SESSION_MODE=fresh` disables resume.
- **Unattended.** `bypassPermissions`, interactive tools disabled (AskUserQuestion, plan mode, cron, …), and the
  Bash guardrails (claude-knight's own list in `src/guardrails.ts`) enforced by a `PreToolUse` hook (a command hook in `cli`, in process in `sdk`). Blocked: `rm -rf /`, `mkfs`, `dd of=/dev/…`, `chmod 777`, and
  `git push` with a `-f`/`--force` flag token (`--force-with-lease` is allowed). Blocked calls are logged with the
  command (first 200 chars) in both runtimes. `curl … | sh` is not blocked.
- **Tools.** Claude Code's built-ins (Bash, Read, Edit, Grep, Glob, WebFetch, WebSearch, Agent, Skill, …);
  every CLI the knight's Nix/mise/apt tools install, through Bash (the operator puts them on `PATH`); the
  Round Table tools below; and any extra MCP servers.
- **Browser.** With `spec.capabilities.browser: true` the operator adds the headless Chrome sidecar; claude-knight
  then exposes `mcp__roundtable__browser_{open,snapshot,click,fill,get_text,screenshot,eval,close}` (same set as
  pi-knight, via the bundled `agent-browser` CLI). Screenshots return as images Claude can see. The
  `agent-browser` CLI also works directly from Bash, so the arsenal's `shared/web-browser` skill works as written.
- **Arsenal compatibility.** Skills written for pi-knight name `nats_request`, `spawn_subagent`, `browser_*`; the
  system prompt maps those to `mcp__roundtable__*` and the `Agent` tool.
- **Personality.** `SOUL.md`, `IDENTITY.md`, `AGENTS.md`, `TOOLS.md` (PVC copy, else `/config`) are appended to
  Claude Code's system prompt each task.

### Declaring a task failed

If the final non-empty line of the agent's answer is `Outcome: failed <reason>` (case-insensitive, with the same tolerant markdown and `:`/`=`/`-` separators as the `Verdict:` line), the result is published with `success: false` and `error` set to the reason (the whole line when there is none). The agent's full text stays in `result`. The phrase anywhere but the last non-empty line is ignored. Use it when a scheduled task's script check rejects the answer and the knight cannot fix it, so the firing is recorded as failed.

## Live activity events

While a task runs the pod publishes core-NATS events (never JetStream) on
`<prefix>.activity.<Knight>.<taskId>`: `task.started`, `task.heartbeat` (with each JetStream `working()`),
`tool.started`/`tool.finished`, `assistant.message`, `task.finished`. Every event has `v`, `type`, `ts`,
`knight`, `pod`, `node`, `taskId`, `runId`, an optional `traceId` (the task's trace id), a per-task `seq` and is at most 8 KiB. Previews are cut
(500 chars output/text, 200 chars tool arguments) and redacted; tool events are limited to 20/s per task.
Set `ACTIVITY_CONTENT=none` to drop all previews. `POD_NAME` and `NODE_NAME` (downward API) identify the
pod; the pod falls back to the hostname and `node` is omitted when unset. Both runtimes share this
implementation (`packages/core/src/activity.ts`, contract v1).

Introspection is served by `packages/core` (`introspect.ts`) over this runtime's session source
(`session-source.ts`). The knight-level subject uses queue group `introspect` (one replica answers); it also
answers per pod on `<prefix>.introspect.<Knight>.<pod>`. Every reply carries `pod` and
`node`, and `stats` has an `inflight` array (taskId, runId, chain/step, model, startedAt, lastHeartbeatAt).

## Authentication and billing

| `CLAUDE_AUTH_MODE` | Credential | Runtime | Billed to |
|---|---|---|---|
| `subscription` (default) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or egress injection (below) | `cli` only | Claude plan usage limits |
| `api` | `ANTHROPIC_API_KEY` (optionally `ANTHROPIC_BASE_URL`, e.g. a gateway) | `sdk` (default) or `cli` | API, or the Max plan's monthly API credit |

Claude Code prefers API keys over the OAuth token, so a stray `ANTHROPIC_API_KEY` in the pod would silently
switch a subscription knight to API billing. claude-knight prevents that: in subscription mode it strips every
API credential (and `ANTHROPIC_BASE_URL`) from the Claude Code environment, and aborts a task if Claude Code
still reports API-key auth (`apiKeySource` in the CLI's `system/init` message). A missing credential leaves the
knight **degraded** (`/ready` 503 with the reason) without binding its NATS consumer, so tasks wait in the
stream instead of failing.

**Egress injection (optional).** The setup-token can stay out of the pod entirely: set
`ANTHROPIC_AUTH_TOKEN` to a placeholder and `ANTHROPIC_CUSTOM_HEADERS="anthropic-beta: oauth-2025-04-20"`, and
have an egress gateway replace the `Authorization: Bearer <placeholder>` header with the real token on the way
to `api.anthropic.com` (the pattern kagent's Claude Code harness uses). claude-knight treats that pair as a
subscription credential: it passes the placeholder, the header and any `ANTHROPIC_BASE_URL` through, does not
require `CLAUDE_CODE_OAUTH_TOKEN`, and still strips `ANTHROPIC_API_KEY`. It is not required; a plain
`CLAUDE_CODE_OAUTH_TOKEN` works without any gateway.

**Plan reserve.** In subscription mode the fleet shares plan windows with your own Claude Code and chat use.
Claude Code reports window utilization; once any window passes `CLAUDE_PLAN_RESERVE` (default `0.8`) or is
rejected, new tasks fail fast with `refused: "quota"` (plus the deprecated `usage_limited: true`) and the reset time, instead of using up the week. While refused, the knight re-checks real usage with one tiny Haiku call at most every 5 minutes and resumes once usage drops back under the reserve (no restart needed). `CLAUDE_PLAN_RESERVE` is re-read on every check.
Utilization is exported as `roundtable_knight_plan_utilization{window=…}`.

**Cost.** `cost` in results and `roundtable_knight_llm_cost_usd_total` are at API list prices. With
`billing: "subscription"` that is the API-equivalent of the work, not money spent.

**Terms.** Anthropic's terms allow a Claude plan's OAuth token (`claude setup-token`) to be used with the
official Claude Code CLI, but not through the Agent SDK or other third-party harnesses; products or services
offered to others should use API keys. That is why subscription mode runs `claude -p` (`cli`) and the `sdk`
runtime is limited to `api` mode. This runtime is meant for running your own knights on your own plan; anyone
else running Roundtable brings their own token. Check Anthropic's current terms before relying on this.

## Configuration

Set by the operator (same as pi-knight): `KNIGHT_NAME`, `KNIGHT_MODEL`, `SUBSCRIBE_TOPICS`, `NATS_URL`,
`NATS_TASKS_STREAM`, `NATS_RESULTS_STREAM`, `NATS_RESULTS_PREFIX`, `MAX_CONCURRENT_TASKS`, `TASK_TIMEOUT_MS`,
`METRICS_PORT`, `LOG_LEVEL`.
`MAX_CONCURRENT_TASKS` defaults to `1` when unset, the same default as pi-knight (shared in `@roundtable/knight-core`).
The task prompt ends with a note giving the task time limit and its UTC stop time (from the task `timeoutMs` or `TASK_TIMEOUT_MS`); set `KNIGHT_TASK_LIMIT_NOTE=off` to leave prompts unchanged.

Set through the Knight's `spec.env` / `spec.envFrom`:

| Variable | Default | |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | setup-token (subscription mode) |
| `CLAUDE_AUTH_MODE` | `subscription` | or `api` |
| `CLAUDE_RUNTIME` | `cli` (subscription), `sdk` (api) | `cli` or `sdk`; `sdk` is refused with `subscription` |
| `CLAUDE_BIN` | `claude` | CLI the `cli` runtime runs |
| `CLAUDE_MODEL` | from `spec.model` | `sonnet`, `opus`, `haiku`, or a `claude-*` id. Non-Claude `spec.model` → plan default |

A task payload may carry an optional `model` (a Claude alias or `claude-*` id); it replaces `CLAUDE_MODEL` for that task only. Non-Claude ids fail the task with an error. Chain-run session resume continues across steps that use different models.
| `CLAUDE_EFFORT` | Claude Code default | `low` `medium` `high` `xhigh` `max` |
| `CLAUDE_PLAN_RESERVE` | `0.8` | 0–1; `1` disables; re-read on every check |
| `CLAUDE_MAX_TURNS` | `0` (none) | turn cap per task |
| `CLAUDE_MAX_BUDGET_USD` | `0` (none) | per-task cap at API-equivalent prices |
| `CLAUDE_SESSION_MODE` | `run` | `run` or `fresh` |
| `MCP_SERVERS_JSON` | — | extra MCP servers (`{"mcpServers":{…}}` or a bare map); merged over `/config/mcp.json` |
| `CLAUDE_DISALLOWED_TOOLS` | — | extra built-ins to disable, comma separated |
| `CLAUDE_CONFIG_DIR` | `/data/.claude-home` | Claude Code state, sessions, linked skills |
| `KNIGHT_MEMORY_DIR` | — | This knight's memory volume, e.g. `/memory/<knight>` (read-write). Set by the operator when a memory volume is mounted; the system prompt states the paths, as in pi-knight |
| `KNIGHT_MEMORY_ROOT` | — | Read-only root holding every knight's memory, e.g. `/memory`; the prompt tells the knight to read, never write, `$KNIGHT_MEMORY_ROOT/<name>/` |

### Telemetry

With `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) set and `OTEL_SDK_DISABLED` not `true`, the Claude Code child gets its built-in OpenTelemetry export switched on: `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`, and `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_LOGS_EXPORTER` set to `otlp`. Its `claude_code.interaction` span is parented to the knight's task span through `TRACEPARENT`. That `invoke_agent` span itself joins the caller's trace via the `traceparent` header of the NATS task message (a root span when there is none), and `OTEL_SERVICE_NAME` defaults to `claude-knight`. Any of these the pod env already sets is left alone.

The knight's own `invoke_agent <knight>` task span carries `roundtable.knight.runtime` (`claude`), `roundtable.chain` and `roundtable.chain.step` (chain tasks only), and on completion `gen_ai.usage.input_tokens` (including cached reads), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens` and `roundtable.cost.usd`.

Prompt and response content is captured by default (`OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`, `OTEL_LOG_TOOL_CONTENT` set to `1`). `ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false` sets them to `0`. This export runs inside the CLI, so `redactSecrets` does not touch it; redaction of these spans is done by the chart collector. `OTEL_LOG_RAW_API_BODIES` is never set. With no OTLP endpoint, the child env is unchanged.

`tests/otel-e2e.test.ts` runs the real CLI against a local OTLP receiver and checks that `claude_code.interaction` is a child of the task span and carries the prompt (and not with capture off).

### GitHub credentials

GitHub App installation tokens expire after an hour, but env vars are frozen at pod start. When the Knight
(or its RoundTable) sets `spec.github.tokenSecretRef`, the operator mounts that Secret read-only and sets
`GITHUB_TOKEN_FILE=/var/run/secrets/roundtable/github/token`, which the kubelet rewrites when the Secret
rotates. With it set, the entrypoint points git at `/usr/local/bin/git-credential-roundtable` (it reads the
file on every call, `username=x-access-token`, `https://github.com` only) and puts `/opt/roundtable/bin`
first on `PATH`. A `gh` shim there exports `GH_TOKEN` from the file per invocation and then execs the real
`gh`. Both runtimes start Claude Code with the pod env, so its Bash tool sees the shim. Neither script logs
the token. Without `GITHUB_TOKEN_FILE` the old `gh auth git-credential` / `GH_TOKEN` behaviour is kept.

Set `spec.concurrency: 1` unless the plan has headroom: each concurrent task is its own Claude Code process.

### Tools

The image bakes its baseline tools (ripgrep, python, yq) at build time; start-up installs nothing. Extra tools
come from the operator's tools image mounted at `/nix` (`spec.tools.nix`).

See `examples/knight-galahad-claude.yaml` for a complete Knight.

## Development

```bash
npm ci
npm test          # unit tests, both runtimes against fakes, and the real CLI against a mock API
npm run build
CK_LIVE_CLAUDE=1 CLAUDE_CODE_OAUTH_TOKEN=… npx tsx --test tests/claude-live.test.ts   # optional, real plan token
```

### Nix dev shell

`flake.nix` pins the toolchain CI uses (Node 22 with npm, plus git, gh and jq) to the same nixpkgs revision as
roundtable-k8s/roundtable. With Nix and flakes enabled:

```bash
nix develop                 # shell with node 22, npm, git, gh, jq
npm ci && npx tsc --noEmit && npm test && npm run build
nix build .#knight-tools    # the same tools as one environment (result/bin), for spec.tools.flakes
```

`tests/` cover config, auth stripping, Bash guardrails, skill linking, NATS payloads, plan reserve, result
classification, session resume and per-task cost on resumed sessions. For the `cli` runtime:
`cli.test.ts` checks the generated arguments and files and parses recorded stream-json fixtures
(`tests/fixtures/stream/`: success, tool use, usage-limit rejection, auth error, API-key auth) through a fake
`claude` binary; `stdio.test.ts` covers the command hook, the stdio MCP server and transcript reading;
`cli-e2e.test.ts` runs the real bundled `claude -p` against a scripted mock of the Messages API (no credential)
to prove the flags, the stdio MCP server, the hook, resume and introspect work together. `claude-live.test.ts`
is skipped unless `CK_LIVE_CLAUDE=1`. The runtime was also run end to end
against a real NATS server and the real Claude Code binary (with a mock Messages API): the model's
`nats_publish` call reached NATS, chain steps resumed one session, the Bash guardrail denied a blocked command,
and a missing token left the knight degraded.

## Known gaps

- `cli` runtime: the stdio MCP server opens its own NATS connection per task and does not retry a failed first
  connect (the tool reports "NATS not connected"). Tool-call metrics come from the stream-json tool results
  instead of `PostToolUse` hooks.
- Bash output secret redaction (pi-knight's `afterToolCall` sanitizer) is not ported: Claude Code hooks can
  rewrite MCP tool output but not built-in tool output.
- Delivery: pull consumer, one fetch per free slot (`MAX_CONCURRENT_TASKS - active`); no in-memory queue, so backlog is visible as
  JetStream consumer lag. Tasks are acked when they finish, with `working()` heartbeats every 10s against a 30s `ack_wait`.
  `max_deliver` stays 1: a task whose knight crashed mid-run is not re-run; a `MAX_DELIVERIES` advisory makes a surviving
  replica publish a failure result (`lost: true`) instead. Known limit: the advisory is missed if no replica of the knight
  is up when the ack window expires.

## Fleet discovery

Each pod registers as the NATS micro service `roundtable-knight`, the same as pi-knight: `nats micro ls roundtable-knight`
lists the fleet and `nats micro stats roundtable-knight` shows load. See the root README's
[Fleet discovery](../../README.md#fleet-discovery) section.

## Draining on rollout

On `SIGTERM` the knight stops fetching new tasks, `/ready` returns 503 (`"status": "draining"`) so the pod
leaves Service endpoints, and in-flight tasks keep heartbeating until they publish their result and ack.
It then exits. The wait is bounded by `DRAIN_TIMEOUT_MS` (default `TASK_TIMEOUT_MS` + 60s - 20s, i.e. 20s inside the
operator's `terminationGracePeriodSeconds` so an aborted task can still publish); the kubelet SIGKILLs after the pod grace period regardless.

A `SIGTERM` during start-up (before the knight logs it is ready) does not wait for anything: the
entrypoint exits at once if it is still in its start-up phases, and the runtime, once running, closes
what it has opened and exits 0 without subscribing, so it never takes a task it would lose at the end
of the grace period.
