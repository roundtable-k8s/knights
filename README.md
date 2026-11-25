# knights

Knight runtimes for [Round Table](https://github.com/roundtable-k8s/roundtable), a Kubernetes platform for
running fleets of AI agents. A knight is the agent process that runs inside a pod: it consumes tasks from NATS,
runs them, and publishes results.

- **pi-knight** runs any model through the [Pi](https://github.com/earendil-works/pi-mono) coding-agent SDK.
- **claude-knight** runs tasks through the Claude Code CLI (headless) or the Claude Agent SDK.

## Layout

```
packages/
  core/          @roundtable/knight-core, shared runtime code
  pi-knight/     pi-knight runtime and image
  claude-knight/ claude-knight runtime and image
```

## Development

Requires Node 22. From the repo root:

```bash
npm ci               # install all workspaces
npm run build        # build every package
npm run typecheck    # typecheck every package
npm test             # run every package's tests
npm run lint         # eslint
```

To run one package's tests:

```bash
npm test --workspace packages/pi-knight
```

Each package keeps its own `flake.nix` and `mise.toml` for now.

## Run a knight locally

No cluster needed: Node 22 and a [`nats-server`](https://docs.nats.io/running-a-nats-service/introduction/installation) binary on `PATH` (or in `NATS_SERVER_BIN`). The [`nats` CLI](https://github.com/nats-io/natscli) is optional. Use three terminals at the repo root.

1. Install and build (the runtimes import the built `packages/core`):

   ```bash
   npm ci && npm run build
   ```

2. Start NATS with what the operator would create: the `fleet_a_tasks` (`fleet-a.tasks.>`) and `fleet_a_results` (`fleet-a.results.>`) streams and the durable pull consumer `<KNIGHT_NAME>-consumer` (explicit ack, `max_deliver` 1, 30 s ack wait). It runs until Ctrl-C and keeps its store in a temp dir:

   ```bash
   npm run dev:nats                       # KNIGHT_NAME=dev, port 4222
   KNIGHT_NAME=dev NATS_PORT=4222 npm run dev:nats
   ```

   It uses the `nats` CLI if it is on `PATH`, otherwise `scripts/dev/nats-setup.ts` (`NATS_SETUP=cli|tsx` forces one). The consumer filters on `SUBSCRIBE_TOPICS`, by default `fleet-a.tasks.<knight name, lowercased>.>`.

3. Start a knight with the same `KNIGHT_NAME` and `SUBSCRIBE_TOPICS`.

   **claude-knight**, with the fake Claude binary the tests use (no credentials, nothing written outside the temp dir):

   ```bash
   export KNIGHT_TMP=$(mktemp -d)
   KNIGHT_NAME=dev SUBSCRIBE_TOPICS='fleet-a.tasks.dev.>' NATS_URL=nats://127.0.0.1:4222 \
   KNIGHT_WORKDIR=$KNIGHT_TMP KNIGHT_CONFIG_DIR=$KNIGHT_TMP/config KNIGHT_SKILLS_DIR=$PWD/scripts/dev/skills \
   CLAUDE_AUTH_MODE=api ANTHROPIC_API_KEY=fake CLAUDE_RUNTIME=cli \
   CLAUDE_BIN=$PWD/packages/claude-knight/tests/helpers/fake-claude.mjs \
   FAKE_CLAUDE_FIXTURE=$PWD/packages/claude-knight/tests/fixtures/stream/success.jsonl \
     npm run dev -w claude-knight
   ```

   The fake binary replays `FAKE_CLAUDE_FIXTURE` (that one answers `pong`). For a real Claude Code run, drop `CLAUDE_BIN` and the `FAKE_CLAUDE_*` and `ANTHROPIC_API_KEY=fake` variables and set a real `ANTHROPIC_API_KEY`, or `CLAUDE_AUTH_MODE=subscription` with `CLAUDE_CODE_OAUTH_TOKEN`. `KNIGHT_SKILLS_DIR` points at a one-skill placeholder so the knight does not wait a minute for git-sync. Unset any knight env your shell already has (`CLAUDE_CONFIG_DIR`, `NATS_TASKS_STREAM`, ...): it overrides these defaults.

   **pi-knight** needs a model key (for example `OPENROUTER_API_KEY`, see [CONFIGURATION](packages/pi-knight/docs/CONFIGURATION.md)). The overrides below move sessions, models and task work dirs off `/data`. The Pi SDK's `cwd` and agent dir are still `/data` (and skills `/skills`, config `/config`), so it needs a writable `/data` for now:

   ```bash
   export KNIGHT_TMP=$(mktemp -d)
   KNIGHT_NAME=dev SUBSCRIBE_TOPICS='fleet-a.tasks.dev.>' NATS_URL=nats://127.0.0.1:4222 \
   KNIGHT_MODEL=openrouter/deepseek/deepseek-v3.2 OPENROUTER_API_KEY=... \
   KNIGHT_WORK_ROOT=$KNIGHT_TMP/work KNIGHT_SESSIONS_ROOT=$KNIGHT_TMP/sessions MODELS_JSON_PATH=$KNIGHT_TMP/models.json \
     npm run dev -w pi-knight
   ```

4. Send a task and wait for its result:

   ```bash
   npm run dev:send -- "Say hello." --knight dev --timeout 120
   ```

   `scripts/dev/send-task.ts` publishes a task payload on `fleet-a.tasks.<domain>.<id>` (`--domain` defaults to the knight name, lowercased) and prints the result from `fleet-a.results.<id>`. It exits 0 on a success result, 1 on a failure result and 2 when no result came within `--timeout` seconds. `--url` (default `NATS_URL` or `nats://127.0.0.1:4222`) points it at another server.

`packages/claude-knight/tests/local-dev.test.ts` runs this flow (steps 2 to 4 with claude-knight); it is skipped without `nats-server`.

## Knight environment

The images do not set `NODE_ENV=production`, and both runtimes strip `NODE_ENV=production` and `npm_config_omit` / `npm_config_production` (see `agentShellEnv` in `packages/core`) from the environment of agent shells: pi-knight scrubs its own process env at startup, claude-knight scrubs the Claude Code child env. So `npm ci` in a repo a knight works on installs its dev dependencies.

pi-knight keeps its state under one data root, `KNIGHT_DATA_DIR` (default `/data`, the PVC). It is the pi SDK `cwd` and `agentDir` (settings, session notes, scratch, long-term memory without a memory volume) and the default root for per-task workspaces (`<root>/work`, override `KNIGHT_WORK_ROOT`), persisted sessions (`<root>/sessions`, override `KNIGHT_SESSIONS_ROOT`) and the custom-model catalog (`<root>/models.json`, override `MODELS_JSON_PATH`). The overrides win over the data root. To run pi-knight outside a pod without touching `/data`, set `KNIGHT_DATA_DIR=$(mktemp -d)`.

The real-NATS tests in `packages/core` (pull loop, rollouts, micro service, roster) need a `nats-server` binary on `PATH` or in `NATS_SERVER_BIN`; without one they are skipped.

## What happens to tasks during a rollout

Each task is delivered at most once (durable pull consumer, `max_deliver: 1`, 30 s `ack_wait`). It is never re-run automatically; retry is manual, through the dead-letter view. When a pod is replaced (new image, spec change, scale-down):

1. On SIGTERM the pod leaves service discovery, `/ready` returns 503 and it stops asking for tasks.
2. A pull request it already had open can still deliver a task. The pod runs that task like any other instead of handing it back (with `max_deliver: 1` a handed-back task is never delivered again, so it would be lost).
3. It waits for running tasks, up to `DRAIN_TIMEOUT_MS`. They keep sending heartbeats (in-progress acks every 10 s), then publish their result and ack.
4. If tasks are still running at the deadline, they are aborted and publish a failure result. Then the pod drains NATS and exits.

A task whose ack deadline passes (the pod crashed, or was too busy to send heartbeats for 30 s) gets a MAX_DELIVERIES advisory. The operator dead-letters it, and one replica of the knight publishes a `lost` failure result for it. No replica publishes that result if the task is running in, or recently finished in, the replica that receives the advisory. None publishes it either if a successful result for the task is already on the results subject. So a task that succeeded is never then reported as failed.

A pod can also be terminated while it is still starting up (a newer ReplicaSet replaces it, or KEDA scales down). Then it never takes a task: the entrypoint traps SIGTERM from its first line and exits during the start-up phases (Nix, flake tools, mise), and the runtime installs its signal handlers before any network call, so a signal before it is ready closes what is open (health server, NATS, telemetry) and exits 0 without starting the pull loop. The pod is gone within seconds instead of the whole grace period.

With the Recreate strategy no pod is pulling between the old pod's exit and the new pod's start. Tasks published in that gap wait in the stream (consumer lag) and run when the new pod starts.

## Fleet discovery

Each knight pod registers as the NATS micro service `roundtable-knight`: see the fleet with `nats micro ls roundtable-knight` and load with `nats micro stats roundtable-knight`. Details in [pi-knight CONFIGURATION](packages/pi-knight/docs/CONFIGURATION.md#fleet-discovery-nats-micro-service).

## Images

Build from the repo root:

```bash
docker build -f packages/pi-knight/Dockerfile .
docker build -f packages/claude-knight/Dockerfile .
```

The images keep their existing names:

- `ghcr.io/roundtable-k8s/pi-knight`
- `ghcr.io/roundtable-k8s/claude-knight`

## History

This repo combines two former repositories, which are now archived:

- `roundtable-k8s/pi-knight`, now `packages/pi-knight`
- `roundtable-k8s/claude-knight`, now `packages/claude-knight`

Their history is kept here. For example, to see the history of pi-knight's `knight.ts`:

```bash
git log --follow packages/pi-knight/src/knight.ts
```

## License

Apache-2.0. See [LICENSE](LICENSE).
