# Observability

> Structured logging, metrics, cost tracking, and health monitoring for knight agents.

## Overview

Every knight must be observable. In a multi-agent system, you need to know: what's running, how long it took, what it cost, and whether it's healthy. Pi-Knight provides three pillars of observability.

## 1. Structured Logging

All logs are one JSON object per line on stdout (`packages/core/src/logger.ts`), compatible with Loki/Promtail ingestion on the dapper-cluster.

### Log Format
```json
{"level":"info","time":"2026-02-23T09:15:56.000Z","pid":1,"hostname":"galahad-56f4d46d9b-9qrwl","knight":"galahad","table":"dev","trace_id":"4bf92f3577b34da6a3ce929d0e0e4736","span_id":"00f067aa0ba902b7","msg":"Executing task","model":"openrouter/deepseek/deepseek-v3.2","taskLength":412,"runId":null,"workDir":"/data/work/..."}
```

Every line carries `level` (a string), `time` (ISO 8601), `pid`, `hostname`, `knight`, `table` (`ROUNDTABLE_TABLE`, `none` when unset) and `msg`. `trace_id` and `span_id` are added only when the line is written inside a task span (see Tracing). The fields after `msg` are per-call context and vary by message.

### Log Levels
Levels are `debug`, `info`, `warn`, `error`; `LOG_LEVEL` sets the minimum written.

| Level | Used for (examples from the code) |
|-------|-----|
| `error` | `Task failed`, `Failed to publish task result — result lost`, `Failed to publish error result` |
| `warn` | `NATS disconnected`, `NATS error status`, `Result publish failed — retrying`, `Task fetch failed — retrying`, `Invalid task payload`, `Task delivered but never acked — reporting failure`, `Result text truncated to fit the payload limit`, `Skill refresh failed` |
| `info` | `NATS connected`, `NATS reconnected`, `Executing task`, `Result published` |
| `debug` | Per-tool-call detail (`Tool call started`), activity publish failures, other diagnostics that would be noise at `info` |

### Key Log Messages
The messages below are the ones the code logs today; use them as search strings in Loki.
- `NATS connected` / `NATS disconnected` / `NATS reconnected` — connection state changes
- `Executing task` — task accepted by the agent (`model`, `taskLength`, `runId`, `workDir`)
- `Result published` — result message sent (`taskId`, `subject`; `attempt` on retries)
- `Task failed` — task errored (`taskId`, `error`)
- `Task delivered but never acked — reporting failure` — a task was delivered but not acknowledged in time, so a failure result is sent

Per-task duration, cost and tokens are not log lines: they are in the task result and in the metrics below.

## 2. Prometheus Metrics

Expose metrics on `/metrics` endpoint (HTTP, same port as health check).

### Metric Definitions

`roundtable_knight_tasks_total` is labelled by `status`. A task whose result cannot be published is counted twice: once as its outcome (`success` or `error`, recorded before the publish) and once as `publish_failed` (the result itself is lost and logged as such). Do not sum over `status` for a task total; use `status!="publish_failed"` or a single status.

Every series carries the constant labels `table` (`ROUNDTABLE_TABLE`, `none` when unset),
`knight` and `runtime` (`pi`). The names are shared with claude-knight (`runtime="claude"`).

```prometheus
# Task execution
roundtable_knight_tasks_total{table="dev",knight="galahad",runtime="pi",status="success"} 42
roundtable_knight_tasks_total{table="dev",knight="galahad",runtime="pi",status="error"} 3
roundtable_knight_tasks_total{table="dev",knight="galahad",runtime="pi",status="lost"} 1

# Task duration (histogram)
roundtable_knight_task_duration_seconds_bucket{table="dev",knight="galahad",runtime="pi",le="60"} 30
roundtable_knight_task_duration_seconds_sum{table="dev",knight="galahad",runtime="pi"} 4523.7
roundtable_knight_task_duration_seconds_count{table="dev",knight="galahad",runtime="pi"} 42

# LLM cost (billing = auth mode; pi-knight is always "api")
roundtable_knight_llm_cost_usd_total{table="dev",knight="galahad",runtime="pi",model="openrouter/deepseek/deepseek-v3.2",billing="api"} 23.47

# Token usage (type = input | output | cache_read | cache_write)
roundtable_knight_llm_tokens_total{table="dev",knight="galahad",runtime="pi",model="openrouter/deepseek/deepseek-v3.2",type="input"} 504000
roundtable_knight_llm_tokens_total{table="dev",knight="galahad",runtime="pi",model="openrouter/deepseek/deepseek-v3.2",type="output"} 357000

# Tool usage (errors are status="error"; there is no separate errors counter)
roundtable_knight_tool_calls_total{table="dev",knight="galahad",runtime="pi",tool="bash",status="success"} 120
roundtable_knight_tool_call_duration_seconds_count{table="dev",knight="galahad",runtime="pi",tool="bash"} 120
roundtable_knight_tool_calls_blocked_total{table="dev",knight="galahad",runtime="pi",tool="bash",reason="..."} 1

# Session health (pi-knight only; outcome = completed | aborted, succeeded | exhausted)
roundtable_knight_compactions_total{table="dev",knight="galahad",runtime="pi",reason="threshold",outcome="completed"} 2
roundtable_knight_llm_retries_total{table="dev",knight="galahad",runtime="pi",outcome="succeeded"} 4
roundtable_knight_session_messages{table="dev",knight="galahad",runtime="pi"} 87

# NATS health and concurrency
roundtable_knight_nats_connected{table="dev",knight="galahad",runtime="pi"} 1
roundtable_knight_nats_reconnects_total{table="dev",knight="galahad",runtime="pi"} 0
roundtable_knight_active_tasks{table="dev",knight="galahad",runtime="pi"} 1
```

Notes on the task counter:
- `status` is `success` or `error` for every task that ran (a timeout or an abort is an `error`), plus `lost` (delivered to a pod that stopped before finishing it; never re-run) and `publish_failed`.
- `publish_failed` is counted **in addition to** the task's `success`/`error`, when the result could not be published. Do not sum across statuses on a dashboard, or such a task is counted twice.

### Grafana Dashboard

With these metrics, a Grafana dashboard can show:
- Tasks per knight over time (throughput)
- Error rate per knight (reliability)
- P50/P95/P99 task duration (performance)
- Cumulative cost per knight (economics)
- Token usage trends (efficiency)
- Active tasks vs capacity (utilization)
- NATS reconnects (connection stability; consumer lag comes from the NATS server)

## 3. Health Checks

HTTP health endpoint for Kubernetes liveness and readiness probes.

### Endpoints

#### `GET /health` — Liveness
Returns 200 while the process is up (also in a degraded state, so the pod is not restarted for a missing credential). Used by Kubernetes liveness probe.

```json
{
  "status": "ok",
  "uptime": 86400,
  "knight": "galahad"
}
```

`uptime` is in seconds.

#### `GET /ready` — Readiness
Returns 200 only when NATS is connected, the knight is not degraded and it is not draining (SIGTERM received). Otherwise returns 503 with `status` set to `draining`, `degraded` or `not_ready`.

```json
{
  "status": "ready",
  "nats": "connected",
  "activeTasks": 1,
  "skillsLoaded": 8,
  "model": "openrouter/deepseek/deepseek-v3.2",
  "knight": "galahad"
}
```

`degradedReason` is present when the knight is degraded. Fields are camelCase; `model` comes from the runtime (`readyExtras`). claude-knight's `/ready` also returns `runtime`, `claudeRuntime` and `billing`.

#### `GET /introspect`
Returns the knight's introspection data (JSON, indented). Not used by the probes.

#### `GET /metrics` — Prometheus
Prometheus-format metrics scrape endpoint.

### Kubernetes Probe Configuration
```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 10
  periodSeconds: 30
readinessProbe:
  httpGet:
    path: /ready
    port: 3000
  initialDelaySeconds: 15
  periodSeconds: 10
```

## 4. Cost Tracking

Pi's `pi-ai` layer provides built-in cost tracking per LLM call. Pi-Knight aggregates this per task.

### Per-Task Cost
Every task result includes:
- Total cost (input tokens × rate + output tokens × rate)
- Token breakdown (input, output, cache read, cache write)
- Model used
- Duration

### Aggregate Tracking
The Prometheus metrics provide rolling totals. Combined with Grafana:
- Daily/weekly/monthly spend per knight
- Cost per task type (security briefing vs household task)
- Model cost comparison (which knights are expensive?)
- Budget alerts (if spend exceeds threshold)

### Cost Optimization Levers
1. **Model selection per knight** — Galahad gets Sonnet, Bedivere gets Haiku
2. **Context compaction** — Pi's built-in compaction reduces token usage on long sessions
3. **Skill-based routing** — Simple tasks get cheaper models automatically
4. **Caching** — Repeated queries can be cached (future extension)

## 5. Alerting

### Recommended Alerts (via Prometheus/Alertmanager)

The alerts below are examples written in PromQL. The operator's chart ships the alert rules the fleet actually uses, in `charts/roundtable-operator/templates/prometheusrule.yaml` (roundtable-k8s/roundtable); prefer those.

| Alert | Condition | Severity |
|-------|-----------|----------|
| KnightDown | `roundtable_knight_nats_connected == 0` for 5m | Critical |
| HighErrorRate | `rate(roundtable_knight_tasks_total{status="error"}[15m]) > 0.3` | Warning |
| TaskPublishFailed | `increase(roundtable_knight_tasks_total{status="publish_failed"}[15m]) > 0` | Warning |
| TaskLost | `increase(roundtable_knight_tasks_total{status="lost"}[15m]) > 0` | Warning |
| HighCost | `rate(roundtable_knight_llm_cost_usd_total[1h]) > 5` | Info |
| NoTasks | No tasks completed in 24h | Info |

There is no timeout status: a task that hits its timeout is counted as `error`. Consumer lag is not exported by the knight; take it from the NATS server's metrics.

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | HTTP port for `/health`, `/ready`, `/metrics` | `3000` |
| `LOG_LEVEL` | Minimum log level (`debug`, `info`, `warn`, `error`) | `info` |

Metrics are always on; there is no switch to disable them.

## Tracing (OpenTelemetry)

Off by default. Tracing starts when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_TRACES_EXPORTER` is set and `OTEL_SDK_DISABLED` is not `true`; the standard `OTEL_*` variables configure the exporter. Resource attributes: `service.name` (default `pi-knight`), `roundtable.knight`, `roundtable.table` (`ROUNDTABLE_TABLE`, default `none`), unless `OTEL_RESOURCE_ATTRIBUTES` sets them. Each task runs in an `invoke_agent <knight>` span that is a child of the W3C `traceparent`/`tracestate` headers on the NATS task message (a root span when they are missing or malformed), and log lines written inside it carry `trace_id` and `span_id`. The task span carries `roundtable.knight.runtime`, `roundtable.chain` and `roundtable.chain.step` (only for chain tasks, absent otherwise), and on completion `gen_ai.usage.input_tokens` (including cached reads and writes), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens`, `roundtable.cost.usd` and `gen_ai.response.model`. Under it, each LLM turn is a `chat <model>` child span (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) and each tool call an `execute_tool <tool>` child span (`gen_ai.tool.name`, `gen_ai.tool.call.id`, error status when the tool reports `isError`), all carrying `gen_ai.operation.name`, `roundtable.knight` and `roundtable.table`. Content capture is on by default: `chat` spans carry `gen_ai.system_instructions`, `gen_ai.input.messages` (the conversation so far; the newest messages are kept when it is cut) and `gen_ai.output.messages` (text plus any tool calls), both as a `[{role, content}]` JSON list that is simpler than the GenAI semconv message schema, `execute_tool` spans `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Every value is passed through `redactSecrets` first and each attribute is capped at 16 KiB (`ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES` changes the cap); a cut value sets `roundtable.content.truncated=true` on the span. `ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false` (or `0`) records no content attributes at all; names, tokens and cost are unaffected. The operator injects this variable from the chart value or per-table `spec.telemetry.captureContent`. Context compaction and LLM auto-retries are span events on the task span, not child spans: `compaction` (`reason`, `aborted`, `will_retry`) when a compaction ends, and `llm.retry` when a retry starts (`attempt`, `max_attempts`, `delay_ms`, `error`) and when it ends (`attempt`, `success`, `error` on failure). Error text is passed through `redactSecrets` and cut to 500 characters. Spans still open when the task ends or is aborted are ended with it. Spans are flushed on shutdown after the drain. claude-knight also hands the task span to the Claude Code child as `TRACEPARENT`.

## claude-knight differences

claude-knight shares the logger, health endpoints and the core metric set above, with `runtime="claude"` instead of `runtime="pi"`. The differences:

- **Metrics:** `roundtable_knight_usage_limit_hits_total` is a core metric both runtimes expose: claude-knight counts tasks that failed on the plan or credit limit, pi-knight counts tasks refused with `refused: "credits"` (the task counter's `status` stays `error`). The session-health series `roundtable_knight_compactions_total`, `roundtable_knight_llm_retries_total` and `roundtable_knight_session_messages` are pi-only. claude-knight adds `roundtable_knight_plan_utilization{window=…}` (plan usage, from `packages/claude-knight/src/plan-limits.ts`). Its task counter also has `status="refused"` (fast-fail while the plan reserve is reached).
- **Billing label:** `billing` is `subscription` or `api` (the auth mode). `roundtable_knight_llm_cost_usd_total` is API list-price cost; in subscription mode it is API-equivalent, not billed spend.
- **Tracing:** the task span is the parent of Claude Code's own spans (`claude_code.interaction`, LLM and tool spans) when an OTLP endpoint is set. The Claude Code child inherits the span as `TRACEPARENT`, and the CLI's own OpenTelemetry export is switched on with `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER` and `OTEL_LOGS_EXPORTER` set to `otlp` (`packages/claude-knight/src/telemetry-env.ts`). Any of these the pod env already sets is left alone. Content in those CLI spans (prompts, responses, tool input and output) is on by default, and `ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false` turns it off; the collector's redaction processor is the redaction step for them, since the export runs inside the CLI.
