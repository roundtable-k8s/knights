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
