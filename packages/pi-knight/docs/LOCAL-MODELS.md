# Running a knight on a local model

A pi-knight can run on a model served inside the cluster (an Ollama pool, vLLM, LiteLLM or any
OpenAI-compatible endpoint). No hosted-provider key is needed. Cost is reported as `0` with
`billing: "local"`.

## How the endpoint is named and configured

pi-knight uses the SDK's own mechanisms; there is no second one.

| What | How |
|------|-----|
| Model | `spec.model` / `KNIGHT_MODEL` = `ollama/<tag>` (for example `ollama/qwen3:14b`). Any provider name that is not in the SDK catalogue or `models.json` is treated as an OpenAI-compatible endpoint. |
| Base URL | `KNIGHT_MODEL_BASE_URL`, else `OPENAI_BASE_URL`, else `OPENAI_API_BASE`. The `ollama` provider defaults to `http://localhost:11434/v1`. The URL must end in `/v1`. |
| Several models or exact limits | A `models.json` catalogue (the models path: `MODELS_JSON_PATH`, default `$KNIGHT_DATA_DIR/models.json`) instead of env. |
| API key | None needed. A placeholder is set when no auth exists for the provider. |

Optional tuning (all per knight, from env):

| Variable | Default | Purpose |
|----------|---------|---------|
| `MODEL_REQUEST_TIMEOUT_MS` | `600000` | HTTP timeout for a model call. Raise it for slow first tokens (cold model load, big prompts). |
| `MODEL_CONTEXT_WINDOW` | `131072` | Context-size hint. Set it to what the server really serves; Ollama's `num_ctx` / `OLLAMA_CONTEXT_LENGTH` must be at least this, or prompts are silently truncated (the boot preflight warns). |
| `MODEL_MAX_TOKENS` | `32768` | Output cap per request. |
| `MODEL_REASONING` | `false` | `true` for reasoning models such as gpt-oss. |
| `TASK_TIMEOUT_MS` | `1800000` | Whole-task timeout. Keep it above the request timeout. |

At start-up the knight probes `<base URL>/models` and fails fast, retrying with back-off, if
the endpoint is unreachable or the model is not pulled.

## Example Knight

Under isolation a knight reaches an in-cluster model server only through
`spec.egress.allowedServices` (roundtable-k8s/roundtable#517).

```yaml
apiVersion: ai.roundtable.io/v1alpha1
kind: Knight
metadata:
  name: scribe-local
spec:
  model: ollama/qwen3:14b
  egress:
    allowedServices:
      - name: ollama-pool
        namespace: ai
        ports: [11434]
  env:
    - name: KNIGHT_MODEL_BASE_URL
      value: http://ollama-pool.ai.svc.cluster.local:11434/v1
    - name: MODEL_CONTEXT_WINDOW
      value: "32768"
    - name: MODEL_REQUEST_TIMEOUT_MS
      value: "1200000"
  # No OPENROUTER_API_KEY / ANTHROPIC_API_KEY secret is mounted.
```

## What works, and what does not

pi-knight is a tool-using agent: every useful task needs structured OpenAI `tool_calls`.

| Model family | Tool use through Ollama `/v1` |
|--------------|-------------------------------|
| Qwen 2.5 / Qwen 3, Llama 3.1+, Mistral, gpt-oss | Generally works. |
| Gemma (see #27), small or base models, models without a tool template | Often does not. The model prints the call as text, or answers without calling anything. |

Treat the table as a starting point and test your model with a small tool-using task first.
A model that cannot call tools can still answer plain prompts, but pi-knight reports a
failure rather than a success with no work done:

- the model wrote tool calls as plain text: `Model returned tool calls as plain text instead of structured tool_calls, so no tool ran. ...`
- a local model produced nothing and made no tool call: `Local model produced no output and made no tool calls. It may not support tool calling ...`

Both give `success: false` and set `error`.

## Telling which model answered

The task result carries `model` (the model that ran, for example `ollama/qwen3:14b`),
`billing: "local"`, `cost: 0` and token counts. The same `billing` label is on the
`roundtable_knight_llm_cost_usd_total` metric.

## Not covered

Routing between local and hosted models per task, deploying or sizing the model server, and
claude-knight (it runs the Claude Code CLI).
