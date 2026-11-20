# claude-knight

A knight runtime for [Roundtable](https://github.com/dapperdivers/roundtable) that runs each task through
**Claude Code** (via the Claude Agent SDK), so knights can run on a **Claude Max/Pro plan** with a
`claude setup-token` instead of per-token API billing.

It is a drop-in replacement for [pi-knight](https://github.com/dapperdivers/pi-knight) on a per-knight basis:
set `spec.image: ghcr.io/dapperdivers/claude-knight:latest` on a Knight. The operator is unchanged — same env
contract, NATS consumer, result payload, `/health` `/ready` `/metrics` `/introspect` endpoints, and the
`<prefix>.introspect.<Knight>` responder the dashboard uses. Chains, Missions and knight-to-knight
`nats_request` work across pi-knights and claude-knights.

## How it runs a task

```
NATS task ──► claude-knight ──► Agent SDK query() ──► Claude Code process (one per task)
                 │                     │                 ├─ built-in tools (Bash, Read, Edit, Grep, WebFetch, Agent, Skill…)
                 │                     │                 ├─ mcp__roundtable__nats_request / nats_publish (in-process MCP)
                 │                     │                 ├─ arsenal skills (/skills → $CLAUDE_CONFIG_DIR/skills)
                 │                     │                 └─ extra MCP servers (MCP_SERVERS_JSON, /config/mcp.json)
                 └─ result ◄───────────┘
NATS result ◄──  {task_id, success, result, cost, tokens, model, turns, billing, runtime}
```

- **Sessions.** Steps of one chain run (`runId`) resume the same Claude Code session; a new run or an ad-hoc
  task starts fresh. Long-term memory lives in files on the PVC (`MEMORY.md`, `memory/`, `session-notes/`),
  as the knight contract in `defaults/AGENTS.md` asks. `CLAUDE_SESSION_MODE=fresh` disables resume.
- **Unattended.** `bypassPermissions`, interactive tools disabled (AskUserQuestion, plan mode, cron, …), and the
  same Bash guardrails as pi-knight enforced by an in-process `PreToolUse` hook.
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

## Authentication and billing

| `CLAUDE_AUTH_MODE` | Credential | Billed to |
|---|---|---|
| `subscription` (default) | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | Claude plan usage limits |
| `api` | `ANTHROPIC_API_KEY` (optionally `ANTHROPIC_BASE_URL`, e.g. a gateway) | API, or the Max plan's monthly API credit |

Claude Code prefers API keys over the OAuth token, so a stray `ANTHROPIC_API_KEY` in the pod would silently
switch a subscription knight to API billing. claude-knight prevents that: in subscription mode it strips every
API credential (and `ANTHROPIC_BASE_URL`) from the Claude Code environment, and aborts a task if Claude Code
still reports API-key auth. A missing credential leaves the knight **degraded** (`/ready` 503 with the reason)
without binding its NATS consumer, so tasks wait in the stream instead of failing.

**Plan reserve.** In subscription mode the fleet shares plan windows with your own Claude Code and chat use.
Claude Code reports window utilization; once any window passes `CLAUDE_PLAN_RESERVE` (default `0.8`) or is
rejected, new tasks fail fast with `usage_limited: true` and the reset time, instead of using up the week.
Utilization is exported as `claude_knight_plan_utilization{window=…}`.

**Cost.** `cost` in results and `claude_knight_llm_cost_dollars_total` are at API list prices. With
`billing: "subscription"` that is the API-equivalent of the work, not money spent.

**Terms.** Anthropic's guidance is that the Agent SDK and `claude -p` signed in with a Claude plan draw from
that plan's limits, and that products or services offered to others should use API keys. This runtime is meant
for running your own knights on your own plan; anyone else running Roundtable brings their own token.

## Configuration

Set by the operator (same as pi-knight): `KNIGHT_NAME`, `KNIGHT_MODEL`, `SUBSCRIBE_TOPICS`, `NATS_URL`,
`NATS_TASKS_STREAM`, `NATS_RESULTS_STREAM`, `NATS_RESULTS_PREFIX`, `MAX_CONCURRENT_TASKS`, `TASK_TIMEOUT_MS`,
`METRICS_PORT`, `LOG_LEVEL`.

Set through the Knight's `spec.env` / `spec.envFrom`:

| Variable | Default | |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | — | setup-token (subscription mode) |
| `CLAUDE_AUTH_MODE` | `subscription` | or `api` |
| `CLAUDE_MODEL` | from `spec.model` | `sonnet`, `opus`, `haiku`, or a `claude-*` id. Non-Claude `spec.model` → plan default |
| `CLAUDE_EFFORT` | Claude Code default | `low` `medium` `high` `xhigh` `max` |
| `CLAUDE_PLAN_RESERVE` | `0.8` | 0–1; `1` disables |
| `CLAUDE_MAX_TURNS` | `0` (none) | turn cap per task |
| `CLAUDE_MAX_BUDGET_USD` | `0` (none) | per-task cap at API-equivalent prices |
| `CLAUDE_SESSION_MODE` | `run` | `run` or `fresh` |
| `MCP_SERVERS_JSON` | — | extra MCP servers (`{"mcpServers":{…}}` or a bare map); merged over `/config/mcp.json` |
| `CLAUDE_DISALLOWED_TOOLS` | — | extra built-ins to disable, comma separated |
| `CLAUDE_CONFIG_DIR` | `/data/.claude-home` | Claude Code state, sessions, linked skills |

Set `spec.concurrency: 1` unless the plan has headroom: each concurrent task is its own Claude Code process.

See `examples/knight-galahad-claude.yaml` for a complete Knight.

## Development

```bash
npm ci
npm test          # unit tests + executeTask against a fake Claude Code stream
npm run build
```

`tests/` cover config, auth stripping, Bash guardrails, skill linking, NATS payloads, plan reserve, result
classification, session resume and per-task cost on resumed sessions. The runtime was also run end to end
against a real NATS server and the real Claude Code binary (with a mock Messages API): the model's
`nats_publish` call reached NATS, chain steps resumed one session, the Bash guardrail denied a blocked command,
and a missing token left the knight degraded.

## Known gaps

- Bash output secret redaction (pi-knight's `afterToolCall` sanitizer) is not ported: Claude Code hooks can
  rewrite MCP tool output but not built-in tool output.
- At-most-once delivery, same as pi-knight: tasks queued in memory are lost if the pod stops.
