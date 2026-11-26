# Tool Management with mise

> Declarative, per-knight tool provisioning via [mise](https://mise.jdx.dev).

## Architecture

```
┌──────────────────────────────────────────────┐
│  Layer 1: Image Baseline (build time)         │
│  /app/mise.toml  → rg, python3, yq           │
│  /app/.mise/     → immutable shims            │
├──────────────────────────────────────────────┤
│  Layer 2: Operator tools image (/nix)         │
│  spec.tools.nix → kubectl, helm, etc.         │
├──────────────────────────────────────────────┤
│  Layer 3: Self-Provisioned (runtime)          │
│  /data/mise.toml → knight installs on-demand  │
│  /data/.mise/    → persists across restarts    │
└──────────────────────────────────────────────┘

PATH: /data/.mise/shims:/app/.mise/shims:...
      (knight + self)    (baseline)
```

## Three Layers

### Layer 1: Image Baseline (`/app/mise.toml`)

Baked at `docker build` time. Every knight gets these. Zero startup cost.

```toml
[tools]
"ubi:BurntSushi/ripgrep" = "latest"   # rg — required by Pi SDK grep tool
python = "3.12"                        # skill scripts
"ubi:mikefarah/yq" = "latest"         # YAML processing
```

Plus system packages via apt: `jq`, `curl`, `git`, `ca-certificates`.

### Layer 1.5: Operator tools image (`/nix`)

Nix tools (`spec.tools.nix`) come from the operator's tools image, mounted read-only at `/nix`.
The entrypoint only puts `$KNIGHT_NIX_PROFILE/bin` (default `/nix/profile/bin`) on `PATH`; it never
installs Nix or builds a flake at start-up. Without a `/nix` mount the step is skipped.

### Layer 2: Knight-Specific Tools

There is no start-up installer. Per-knight tools come from the operator's tools image (Layer 1.5);
the per-knight `/config` mise and apt lists are no longer read.

### Layer 3: Self-Provisioned (`/data/mise.toml`)

Knights can install tools themselves during task execution:

```bash
mise use "ubi:owner/repo"
mise install
```

This writes to `/data/mise.toml` on the PVC — persists across pod restarts.
No image rebuild, no ConfigMap change, no human intervention.

If a knight repeatedly needs a tool, it should mention this in its task results so the tool can be promoted to Layer 2 (`spec.tools.nix`).

## Adding Tools to a Knight

### Via Self-Provisioning (Layer 3 — ad-hoc needs)

Knights install tools themselves during task execution. See `defaults/AGENTS.md` for knight-facing docs.

## Available Backends

| Backend | Syntax | Best For |
|---------|--------|----------|
| **core** | `python = "3.12"` | Languages (python, node, go, ruby, java) |
| **ubi** | `"ubi:owner/repo" = "latest"` | GitHub releases (pre-built binaries) |
| **npm** | `"npm:pkg" = "latest"` | npm CLI tools |
| **pipx** | `"pipx:pkg" = "latest"` | Python CLI tools |

For system packages (nmap, whois, etc.), use `spec.tools.nix`.

## Tool Discovery

```bash
mise registry | grep kubectl
mise registry | grep helm
```

## Pinning Versions

```toml
[tools]
kubectl = "1.31.0"
"ubi:helm/helm" = "3.16.0"
```

Use `latest` for tools where you always want the newest (mise caches and only re-fetches periodically).
