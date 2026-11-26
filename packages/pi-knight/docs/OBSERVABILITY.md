# Observability

> Structured logging, metrics, cost tracking, and health monitoring for knight agents.

## Overview

Every knight must be observable. In a multi-agent system, you need to know: what's running, how long it took, what it cost, and whether it's healthy. Pi-Knight provides three pillars of observability.

## 1. Structured Logging

All logs are JSON, compatible with Loki/Promtail ingestion on the dapper-cluster.

### Log Format
```json
{
  "level": 30,
  "time": 1771813756000,
  "pid": 1,
  "hostname": "galahad-56f4d46d9b-9qrwl",
  "knight": "galahad",
  "taskId": "security-1771813755-33254",
  "msg": "Task completed",
  "duration_ms": 45000,
  "cost": 0.54,
  "model": "openrouter/deepseek/deepseek-v3.2",
  "tokens": { "input": 12000, "output": 8500 }
}
```

### Log Levels
| Level | Use |
|-------|-----|
| `error` (50) | Task failures, NATS disconnections, unrecoverable errors |
| `warn` (40) | Task timeouts, retry attempts, degraded state |
| `info` (30) | Task received, task completed, NATS connected, health checks |
| `debug` (20) | Tool calls, skill activation, LLM request/response metadata |

### Key Events to Log
- `nats.connected` — NATS connection established
- `nats.disconnected` — NATS connection lost
- `nats.reconnected` — NATS connection restored
- `task.received` — Task message consumed from JetStream
- `task.acked` — Message acknowledged (after the task finishes and its result is published)
- `task.started` — Pi agent loop invoked
- `task.tool_call` — Individual tool invocation (name, duration)
- `task.skill_activated` — Skill matched and loaded
- `task.completed` — Task finished (success, duration, cost, tokens)
- `task.failed` — Task errored (error message, stack trace)
- `task.timeout` — Task exceeded timeout limit
- `health.check` — Periodic health status

## 2. Prometheus Metrics

Expose metrics on `/metrics` endpoint (HTTP, same port as health check).

### Metric Definitions

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
roundtable_knight_active_tasks{table="dev",knight="galahad",runtime="pi"} 1
```

### Grafana Dashboard

With these metrics, a Grafana dashboard can show:
- Tasks per knight over time (throughput)
- Error rate per knight (reliability)
- P50/P95/P99 task duration (performance)
- Cumulative cost per knight (economics)
- Token usage trends (efficiency)
- Active tasks vs capacity (utilization)
- NATS consumer lag (backpressure)

## 3. Health Checks

HTTP health endpoint for Kubernetes liveness and readiness probes.

### Endpoints

#### `GET /health` — Liveness
Returns 200 if the process is alive. Used by Kubernetes liveness probe.

```json
{
  "status": "ok",
  "uptime_seconds": 86400,
  "knight": "galahad"
}
```

#### `GET /ready` — Readiness
Returns 200 if NATS is connected and the agent is ready to accept tasks. Returns 503 if degraded.

```json
{
  "status": "ready",
  "nats": "connected",
  "consumer": "galahad-consumer",
  "pending_messages": 0,
  "active_tasks": 1,
  "max_concurrent": 2,
  "model": "openrouter/deepseek/deepseek-v3.2",
  "skills_loaded": 8
}
```

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

| Alert | Condition | Severity |
|-------|-----------|----------|
| KnightDown | `roundtable_knight_nats_connected == 0` for 5m | Critical |
| HighErrorRate | `rate(roundtable_knight_tasks_total{status="error"}[15m]) > 0.3` | Warning |
| TaskTimeout | `roundtable_knight_tasks_total{status="timeout"}` increases | Warning |
| TaskLost | `increase(roundtable_knight_tasks_total{status="lost"}[15m]) > 0` | Warning |
| HighCost | `rate(roundtable_knight_llm_cost_usd_total[1h]) > 5` | Info |
| ConsumerLag | Pending messages > 10 for 10m | Warning |
| NoTasks | No tasks completed in 24h | Info |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | HTTP port for health/metrics | `3000` |
| `LOG_LEVEL` | Minimum log level | `info` |
| `ENABLE_METRICS` | Enable Prometheus metrics | `true` |

## Tracing (OpenTelemetry)

Off by default. Tracing starts when `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_TRACES_EXPORTER` is set and `OTEL_SDK_DISABLED` is not `true`; the standard `OTEL_*` variables configure the exporter. Resource attributes: `service.name` (default `pi-knight`), `roundtable.knight`, `roundtable.table` (`ROUNDTABLE_TABLE`, default `none`), unless `OTEL_RESOURCE_ATTRIBUTES` sets them. Each task runs in an `invoke_agent <knight>` span that is a child of the W3C `traceparent`/`tracestate` headers on the NATS task message (a root span when they are missing or malformed), and log lines written inside it carry `trace_id` and `span_id`. The task span carries `roundtable.knight.runtime`, `roundtable.chain` and `roundtable.chain.step` (only for chain tasks, absent otherwise), and on completion `gen_ai.usage.input_tokens` (including cached reads), `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `roundtable.cost.usd` and `gen_ai.response.model`. Under it, each LLM turn is a `chat <model>` child span (`gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`) and each tool call an `execute_tool <tool>` child span (`gen_ai.tool.name`, `gen_ai.tool.call.id`, error status when the tool reports `isError`), all carrying `gen_ai.operation.name`, `roundtable.knight` and `roundtable.table`. Content capture is on by default: `chat` spans carry `gen_ai.system_instructions`, `gen_ai.input.messages` (the conversation so far; the newest messages are kept when it is cut) and `gen_ai.output.messages` (text plus any tool calls), both as a `[{role, content}]` JSON list that is simpler than the GenAI semconv message schema, `execute_tool` spans `gen_ai.tool.call.arguments` and `gen_ai.tool.call.result`. Every value is passed through `redactSecrets` first and each attribute is capped at 16 KiB (`ROUNDTABLE_TELEMETRY_CONTENT_MAX_BYTES` changes the cap); a cut value sets `roundtable.content.truncated=true` on the span. `ROUNDTABLE_TELEMETRY_CAPTURE_CONTENT=false` (or `0`) records no content attributes at all; names, tokens and cost are unaffected. The operator injects this variable from the chart value or per-table `spec.telemetry.captureContent`. Context compaction and LLM auto-retries are span events on the task span, not child spans: `compaction` (`reason`, `aborted`, `will_retry`) when a compaction ends, and `llm.retry` when a retry starts (`attempt`, `max_attempts`, `delay_ms`, `error`) and when it ends (`attempt`, `success`, `error` on failure). Error text is passed through `redactSecrets` and cut to 500 characters. Spans still open when the task ends or is aborted are ended with it. Spans are flushed on shutdown after the drain. claude-knight also hands the task span to the Claude Code child as `TRACEPARENT`.
