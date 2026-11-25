# Agent guide

Instructions for coding agents working in this repo. See [README.md](README.md) for the layout.

## Commands

Run from the repo root:

```bash
npm ci
npm run build
npm run typecheck
npm test
npm run lint
npm test --workspace packages/pi-knight   # one package
```

## Rules

- Work in one package unless the task says otherwise.
- Shared code goes in `packages/core`.
- Run typecheck, test and lint before pushing.
- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Never add AI attribution lines (for example "Co-Authored-By" or "Generated with" footers) to commits or PRs.
