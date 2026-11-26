# Configuration

> How knights are differentiated through configuration, not code.

## Principle

Every knight runs the **same Docker image**. Identity, personality, capabilities, and model selection are injected via Kubernetes ConfigMaps, Secrets, and environment variables. Skill filtering is managed by the operator's sidecars (git-sync + skill-filter) — the runtime loads all skills from mounted paths.

## Configuration Layers

```
┌─────────────────────────────────┐
│  Environment Variables           │  Model, timeouts, NATS config
├─────────────────────────────────┤
│  ConfigMap (personality files)   │  SOUL.md, IDENTITY.md
├─────────────────────────────────┤
│  ExternalSecret (credentials)    │  API keys, tokens
├─────────────────────────────────┤
│  Image Defaults                  │  AGENTS.md, base TOOLS.md
└─────────────────────────────────┘
```

### File Overlay Priority
1. **PVC** (`/data`) — Knight's own edits (highest priority, persists across restarts)
2. **ConfigMap** (`/config`) — Injected personality files (SOUL.md, IDENTITY.md)
3. **Image Defaults** (`/app/defaults`) — Base operational contract (fallback)

Pi SDK's `DefaultResourceLoader` handles this natively:
- `cwd=/data` — project-local discovery (PVC workspace)
- `agentDir=/config` — global config (ConfigMap personality files, AGENTS.md)
- `additionalSkillPaths=["/skills"]` — merged arsenal skills built by the skill-filter sidecar

Knights can evolve their own files over time — ConfigMap seeds the initial state, the knight's own modifications on PVC take priority.

## Environment Variables

### Required
| Variable | Description | Example |
|----------|-------------|---------|
| `KNIGHT_NAME` | Knight identifier | `galahad` |
| `SUBSCRIBE_TOPICS` | NATS subject filter (comma-separated) | `fleet-a.tasks.security.>` |

### Data paths
| Variable | Description | Default |
|----------|-------------|---------|
| `KNIGHT_DATA_DIR` | Data root: SDK `cwd`/`agentDir`, session notes, scratch, default root of the paths below | `/data` |
| `KNIGHT_WORK_ROOT` | Per-task workspaces | `$KNIGHT_DATA_DIR/work` |
| `KNIGHT_SESSIONS_ROOT` | Directory pi-knight lists and prunes session JSONL files in (see Session Persistence): the SDK writes sessions under its agent directory (`KNIGHT_DATA_DIR`), not here | `$KNIGHT_DATA_DIR/sessions` |
| `MODELS_JSON_PATH` | Custom-model catalog | `$KNIGHT_DATA_DIR/models.json` |

### LLM Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `KNIGHT_MODEL` | LLM provider/model | `openrouter/deepseek/deepseek-v3.2` |
| `KNIGHT_THINKING` | Thinking level (off/minimal/low/medium/high) | `off` |
| `KNIGHT_MODEL_BASE_URL` | Base URL of a local OpenAI-compatible endpoint (see [Local models](LOCAL-MODELS.md)) | unset |
| `MODEL_REQUEST_TIMEOUT_MS` | HTTP timeout for a model call | `600000` |
| `MODEL_CONTEXT_WINDOW` | Context-size hint for models not in the catalogue | `131072` |
| `PI_MODELS_JSON` | Raw models-file content to write at startup (to the models path) | unset |
| `PI_MODELS_JSON_B64` | Base64-encoded models-file content (written to the models path) | unset |
| `OPENROUTER_API_KEY` | OpenRouter key — covers the default + most upgrade models | From ExternalSecret |
| `ANTHROPIC_API_KEY` | Anthropic API key (only for native `anthropic/...` models) | From ExternalSecret |
| `OPENAI_API_KEY` | OpenAI API key (only for native `openai/...` models) | From ExternalSecret |
| `GEMINI_API_KEY` | Google API key (only for native `google/...` models) | From ExternalSecret |

A task payload may carry an optional `model` (`provider/model`, routing suffixes such as `:floor` allowed). It is resolved through the ModelRuntime and used for that task only (the session switches model, then the knight default is restored); the result reports the model used. A model missing from the catalog/`models.json` fails the task instead of falling back.

### NATS Configuration
| Variable | Description | Default |
|----------|-------------|---------|
| `NATS_URL` | NATS server URL | `nats://nats.database.svc.cluster.local:4222` |
| `TASK_TIMEOUT_MS` | Default task timeout (ms) | `1800000` (30 min) |
| `MAX_CONCURRENT_TASKS` | Max parallel task execution (same default in claude-knight; the operator always sets it) | `1` |

### Sessions
Every task gets a fresh agent session unless it continues a chain run: tasks
carrying the same operator `runId` (`TaskPayload.RunID`) share one session, while a
new `runId` — or no `runId` at all (ad-hoc NATS tasks) — starts a fresh session, so
context never bleeds between tasks. A pristine pre-warmed session is adopted rather
than recreated. Prior session history is never resumed at startup; long-term memory
lives in files on the PVC (`MEMORY.md`, `memory/*.md`). Every session is persisted as a JSONL
file under `$KNIGHT_DATA_DIR/sessions` (default `/data/sessions`); old files are pruned at startup and on each run change.

| Variable | Description | Default |
|----------|-------------|---------|
| `SESSION_RETENTION_MAX_FILES` | Max persisted session files kept on the PVC (`0` = no cap) | `100` |
| `SESSION_RETENTION_DAYS` | Delete session files not modified for this many days (`0` = no cap) | `30` |
| `ABORTED_TASK_IS_FAILURE` | `true`: a task whose last assistant message ended aborted or in an LLM error is published `success: false`, with `Task timed out. Partial output: ...` / `LLM call failed: ...` and any partial text, instead of succeeding with its earlier narration | `false` |
| `ACTIVITY_CONTENT` | `preview` publishes tool output / message previews in activity events; `none` omits them | `preview` |
| `POD_NAME`, `NODE_NAME` | Pod identity stamped on activity events and introspect replies (downward API); falls back to hostname / unset | — |

### Memory
By default long-term memory lives in `/data` (`MEMORY.md`, `memory/YYYY-MM-DD.md`). When the operator
mounts a memory volume it sets these (both optional):

| Variable | Description |
|----------|-------------|
| `KNIGHT_MEMORY_DIR` | This knight's memory volume, e.g. `/memory/<knight>` (read-write) |
| `KNIGHT_MEMORY_ROOT` | Read-only root holding every knight's memory, e.g. `/memory`; the prompt tells the knight to read, never write, `$KNIGHT_MEMORY_ROOT/<name>/` |

With `KNIGHT_MEMORY_DIR` set the layout is `$KNIGHT_MEMORY_DIR/MEMORY.md` and
`$KNIGHT_MEMORY_DIR/memory/YYYY-MM-DD-<hostname>.md` (one daily log per pod, so replicas never append to the
same file); session notes and scratch stay in `/data`. The system prompt states these paths and overrides the
`/data` paths in `AGENTS.md`. On start, if the volume has no `MEMORY.md` and `/data/MEMORY.md` exists, `MEMORY.md`
and `memory/` are copied across once (existing files are never overwritten). Runtime writes to `MEMORY.md` use a
temp file and rename.

### Observability
| Variable | Description | Default |
|----------|-------------|---------|
| `METRICS_PORT` | Health/metrics HTTP port | `3000` |
| `LOG_LEVEL` | Log verbosity (debug/info/warn/error) | `info` |

## Fleet discovery (NATS micro service)

Every knight pod (pi-knight and claude-knight) registers as the NATS micro service `roundtable-knight`, so liveness, skills and load are visible without Kubernetes access. It is for discovery and health only: tasks still arrive over JetStream, and the service takes none.

```bash
nats micro ls roundtable-knight      # who is alive (one row per pod)
nats micro info roundtable-knight    # metadata per pod
nats micro stats roundtable-knight   # load per pod
```

`$SRV.PING`, `$SRV.INFO` and `$SRV.STATS` (all `.roundtable-knight`) work too. INFO metadata (all strings): `table`, `knight`, `domain`, `model`, `runtime`, `pod`, and `skills`, a JSON array of `{name, description, category}` read from the `SKILL.md` frontmatter under `/skills` (capped at 8 KB; descriptions are truncated first). The table is `ROUNDTABLE_TABLE`, falling back to the NATS prefix. The skill list is re-read before each task and the service re-registered when it changed.

STATS returns `{activeTasks, maxConcurrentTasks, tasksTotal, tasksFailed, lastTaskAt}`. A read-only request endpoint on `$RT.<table>.<knight>.card` returns the INFO metadata. On SIGTERM the service stops first, so a draining pod drops out of PING at once.

## Skill Filtering

Skill filtering is managed at the **deployment layer**, not in pi-knight code:

- **git-sync** sidecars (one per arsenal in `spec.arsenal` + `spec.arsenals`) sync each repo to `/arsenal/<name>`
- **skill-filter** links the categories in the Knight's `spec.skills` into `/skills/<category>/<skill>`; when several arsenals provide the same skill, the last one wins
- Pi SDK's `loadSkills()` loads everything from `/skills` — no runtime filtering

See [Skills](SKILLS.md#arsenal-delivery) for the layout and an example.

This keeps the runtime simple and lets GitOps control what each knight can do.

## Native Tools

Pi-knight registers custom tools alongside Pi SDK's built-in coding tools:

| Tool | Description | Source |
|------|-------------|--------|
| `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` | File I/O and shell | Pi SDK built-in |
| `nats_publish` | Fire-and-forget NATS message | pi-knight custom |
| `nats_request` | Cross-knight collaboration (send + wait) | pi-knight custom |
| `find_knights` | List the knights at your table from their agent cards | knight-core roster |

## Session Persistence

Knights maintain persistent sessions across tasks:
- Session state stored as JSONL on PVC (`/data`)
- Pi SDK auto-compacts when context grows too large
- Knights remember previous tasks within their session lifetime
- Survives pod restarts (PVC-backed)

## Thinking Level

`KNIGHT_THINKING` can also be overridden per-task by the dispatching agent via the NATS message metadata. This lets Tim request deeper reasoning for complex tasks without changing the knight's default.

## ConfigMap Structure

Each knight gets a ConfigMap with personality files:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: galahad-config
  namespace: roundtable
data:
  SOUL.md: |
    # Galahad — The Shield of the Realm
    ...
  IDENTITY.md: |
    - Name: Sir Galahad
    - Domain: Security & Threat Intelligence
    ...
```

## Secrets Management

API keys and tokens managed via Infisical → ExternalSecret → K8s Secret:

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: galahad-secret
  namespace: roundtable
spec:
  secretStoreRef:
    kind: ClusterSecretStore
    name: infisical
  target:
    name: galahad-secret
  dataFrom:
    - find:
        name:
          regexp: "^ANTHROPIC_.*"
```

### GitHub credentials

GitHub App installation tokens expire after an hour, but env vars are frozen at
pod start. When the Knight (or its RoundTable) sets `spec.github.tokenSecretRef`,
the operator mounts that Secret read-only and sets
`GITHUB_TOKEN_FILE=/var/run/secrets/roundtable/github/token`. The kubelet
rewrites the file when the Secret rotates. With it set, the entrypoint:

- configures git to use `/usr/local/bin/git-credential-roundtable`, which reads
  the file on every call and answers `username=x-access-token` for
  `https://github.com`
- puts `/opt/roundtable/bin` first on `PATH`, where a `gh` shim exports
  `GH_TOKEN` from the file per invocation and then execs the real `gh`

Neither script logs the token. Without `GITHUB_TOKEN_FILE` the old behaviour is
kept: `gh auth git-credential` as the git helper when `gh` is installed, else a
static store written from `GH_TOKEN`.

## Model Selection Strategy

**Cheap by default, upgrade per knight.** The whole fleet runs the default
`KNIGHT_MODEL` (`openrouter/deepseek/deepseek-v3.2`) unless a knight sets its own
`KNIGHT_MODEL`. Routing everything through OpenRouter means one `OPENROUTER_API_KEY`
secret covers the default *and* the upgrade models — no per-provider key sprawl.

The default was chosen for running many agents cheaply: it's a competent tool-caller
(important — weak tool models loop and retry, which costs more per finished task) and
it supports prompt caching, which matters because each knight reuses a persistent
session with a large stable prefix (preamble + AGENTS.md/SOUL.md + skills).

To upgrade an individual knight, set `KNIGHT_MODEL` on its pod:

| Need | Suggested `KNIGHT_MODEL` | Why |
|------|--------------------------|-----|
| Fleet default (cheap) | `openrouter/deepseek/deepseek-v3.2` | Cheap, good tools, cached |
| Cheapest viable | `openrouter/google/gemini-2.5-flash-lite` | Lowest cost, 1M context |
| Hard reasoning / writing | `openrouter/anthropic/claude-sonnet-4.6` | Strongest general model |
| Reliable cheap tier | `openrouter/anthropic/claude-haiku-4.5` | Best tool reliability under $1/M in |
| Long-context research | `openrouter/google/gemini-2.5-pro` | 1M+ context, strong synthesis |

```yaml
# Upgrade just this knight; the rest of the fleet stays on the default.
env:
  - name: KNIGHT_MODEL
    value: "openrouter/anthropic/claude-sonnet-4.6"
```

These are starting points — adjust based on observed task quality and cost. The
`/model` cost columns in `pi-ai`'s registry (input/output/cacheRead per M tokens)
are the source of truth when comparing options.

## Native Provider Override

For experiments where Pi SDK should use a native provider config instead of only
`KNIGHT_MODEL`, inject a Pi models file at startup:

```yaml
env:
  - name: KNIGHT_MODEL
    value: "local/gemma4-26b"
  - name: PI_MODELS_JSON_B64
    valueFrom:
      secretKeyRef:
        name: galahad-secret
        key: PI_MODELS_JSON_B64
```

At startup, `entrypoint.sh` writes the provided content to:

```text
$MODELS_JSON_PATH, else $KNIGHT_DATA_DIR/models.json (default /data/models.json)
```

This is the path the runtime reads, so the pi `ModelRuntime` loads it automatically. If `MODELS_JSON_PATH` points at a read-only location (for example a ConfigMap mount) the entrypoint logs a warning and skips the write.
It is intended for canary deployments such as native Ollama experiments,
without changing the default fleet path.

> **Note:** in `models.json`, `apiKey`/`headers` values are treated as
> literals. To read from an environment variable, use explicit syntax —
> `"apiKey": "$OPENROUTER_API_KEY"` (or `"${OPENROUTER_API_KEY}"`), not the bare
> variable name.
