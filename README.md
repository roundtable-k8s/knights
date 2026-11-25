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

## Knight environment

The images do not set `NODE_ENV=production`, and both runtimes strip `NODE_ENV=production` and `npm_config_omit` / `npm_config_production` (see `agentShellEnv` in `packages/core`) from the environment of agent shells: pi-knight scrubs its own process env at startup, claude-knight scrubs the Claude Code child env. So `npm ci` in a repo a knight works on installs its dev dependencies.

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
