# Contributing

This repo holds the Round Table knight runtimes (`packages/pi-knight`, `packages/claude-knight`) and their shared core (`packages/core`). The platform itself, including the operator, CRDs and Helm chart, lives in [roundtable-k8s/roundtable](https://github.com/roundtable-k8s/roundtable).

## Setup

Node 22 and npm. From the repo root:

```bash
npm ci
npm run typecheck
npm test
npm run lint
npm run build
```

To work on one package, add `--workspace`, for example `npm test --workspace packages/pi-knight`.

To run a knight on your machine against a local NATS server and send it a task (no cluster), see [Run a knight locally](README.md#run-a-knight-locally) in the README.

Images build from the repo root:

```bash
docker build -f packages/pi-knight/Dockerfile .
docker build -f packages/claude-knight/Dockerfile .
```

## Changes

- Keep a change to one package unless it really spans more. Code both runtimes need goes in `packages/core`.
- Add or update tests with the change. Run typecheck, tests and lint before pushing.
- Tests must not read the ambient environment. Knight pods set `ROUNDTABLE_TABLE`, `KNIGHT_NAME`, `NATS_URL` and similar, so `scripts/test/hermetic-env.ts` clears them before every test file (loaded by each package's `test` script). Set what a test needs inside the test, and pass an explicit `env` to spawned processes. `npm run test:hermetic` runs the suites with `ROUNDTABLE_TABLE` and `KNIGHT_NAME` set to check this; CI runs it.
- The task, result and activity payloads are a contract with the operator ([knight task contract](https://github.com/roundtable-k8s/roundtable/blob/main/docs/knight-task-contract.md)). A change to them needs the matching change in roundtable.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, with an optional scope such as `fix(pi-knight):`).
- Open a pull request against `main`. PRs are squash-merged through the merge queue once CI passes.

## Issues

Use the issue templates. For anything security-related, see [SECURITY.md](SECURITY.md) and do not open a public issue.
