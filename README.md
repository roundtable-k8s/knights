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
