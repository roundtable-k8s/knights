#!/bin/bash
# entrypoint.sh — Claude-Knight startup (same phases as pi-knight, minus Pi model config)
#
# Architecture:
#   - Nix tools come from the operator's tools image, mounted read-only at /nix
#     (profile at $KNIGHT_NIX_PROFILE, normally /nix/profile). Nothing is
#     installed or built at start-up.
#
# Mount requirements:
#   /nix    → tools image (read-only image volume, optional)
#   /data   → PVC (workspace, memory, mise tools)
#   /config → ConfigMap (SOUL.md, mise.toml, etc.)

# First statement: trap SIGTERM/SIGINT so a pod deleted during start-up exits
# at once instead of starting the knight (see startup-signals.sh).
# shellcheck source=../../core/scripts/startup-signals.sh
. "$(dirname "$0")/startup-signals.sh"

set -eo pipefail

log() { echo "[entrypoint] $(date '+%H:%M:%S') $*"; }

# ──────────────────────────────────────────────────────────────────
# Phase 1: Workspace seeding (from defaults + ConfigMap)
# ──────────────────────────────────────────────────────────────────
log "Phase 1: Workspace"
mkdir -p /data/memory /data/session-notes /data/scratch

# Seed operational files from image defaults (only if missing on PVC)
if [ -d /app/defaults ]; then
  for f in /app/defaults/*.md; do
    fname=$(basename "$f")
    [ ! -f "/data/$fname" ] && cp "$f" "/data/$fname" && log "  Seeded $fname"
  done
fi

# Sync personality files from ConfigMap → PVC (hash-gated)
# Only overwrites when ConfigMap content actually changed.
# Knights can self-modify /data/ files, but CRD-driven changes win.
mkdir -p /data/.config-hashes
for f in SOUL.md IDENTITY.md TOOLS.md; do
  if [ -f "/config/$f" ]; then
    config_hash=$(md5sum "/config/$f" | cut -d' ' -f1)
    stored_hash=""
    [ -f "/data/.config-hashes/$f" ] && stored_hash=$(cat "/data/.config-hashes/$f")
    if [ "$config_hash" != "$stored_hash" ]; then
      cp "/config/$f" "/data/$f"
      echo "$config_hash" > "/data/.config-hashes/$f"
      if [ -z "$stored_hash" ]; then
        log "  Seeded $f from ConfigMap"
      else
        log "  Updated $f from ConfigMap (hash changed)"
      fi
    fi
  fi
done

rt_phase_mark "Phase 1"

# ──────────────────────────────────────────────────────────────────
# Phase 1.5: Claude Code config dir on the PVC
# ──────────────────────────────────────────────────────────────────
# Sessions, linked skills and Claude Code state live under CLAUDE_CONFIG_DIR so
# they survive restarts. Mark onboarding done so the CLI never prompts.
export CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-/data/.claude-home}"
mkdir -p "$CLAUDE_CONFIG_DIR/skills"
if [ ! -f "$CLAUDE_CONFIG_DIR/.claude.json" ]; then
  echo '{"hasCompletedOnboarding":true}' > "$CLAUDE_CONFIG_DIR/.claude.json"
fi
# Optional MCP servers from the knight ConfigMap are read at task time from
# /config/mcp.json; nothing to do here.
log "Phase 1.5: Claude config dir $CLAUDE_CONFIG_DIR ✓"

rt_phase_mark "Phase 1.5"

# ──────────────────────────────────────────────────────────────────
# Phase 2: Nix tools profile (read-only, from the tools image)
# ──────────────────────────────────────────────────────────────────
# /nix is the operator's tools image mounted read-only; put its profile on
# PATH. Without a /nix mount there is nothing to do.
if [ -d /nix ]; then
  KNIGHT_NIX_PROFILE="${KNIGHT_NIX_PROFILE:-/nix/profile}"
  if [ -d "$KNIGHT_NIX_PROFILE/bin" ]; then
    export PATH="$KNIGHT_NIX_PROFILE/bin:$PATH"
    export NIX_CONF_DIR="/nix/etc/nix"
    log "Phase 2: Shared Nix store (read-only) — profile $KNIGHT_NIX_PROFILE ✓"
  else
    log "Phase 2: /nix mounted but no profile at $KNIGHT_NIX_PROFILE"
  fi
else
  log "Phase 2: No /nix mount — skipping Nix"
fi

rt_phase_mark "Phase 2"

# ──────────────────────────────────────────────────────────────────
# Phase 4.5: Vault write check
# ──────────────────────────────────────────────────────────────────
if [ -d "/vault" ]; then
  VAULT_WRITABLE="false"
  for wpath in Briefings Roundtable; do
    if [ -d "/vault/$wpath" ]; then
      if touch "/vault/$wpath/.write-test" 2>/dev/null; then
        rm -f "/vault/$wpath/.write-test"
        VAULT_WRITABLE="true"
      fi
    fi
  done
  if [ "$VAULT_WRITABLE" = "true" ]; then
    log "Phase 4.5: Vault writable paths verified ✓"
    export VAULT_WRITABLE=true
  else
    log "  WARNING: Vault mounted but writable paths NOT writable"
    export VAULT_WRITABLE=false
  fi
else
  log "Phase 4.5: No vault mount — skipping"
fi
rt_phase_mark "Phase 4.5"

# Phase 4.9: Git credential setup
# ──────────────────────────────────────────────────────────────────
# With GITHUB_TOKEN_FILE (set by the operator when spec.github.tokenSecretRef
# is configured) git reads the refreshing token file on every call; otherwise
# gh / GH_TOKEN env as before. See scripts/github/configure-git.sh.
# shellcheck source=scripts/github/configure-git.sh
. /app/scripts/github/configure-git.sh
rt_phase_mark "Phase 4.9"

# Phase 5: Start the knight
# ──────────────────────────────────────────────────────────────────
# exec: the runtime replaces this shell as PID 1 and gets SIGTERM directly; it
# installs its own handlers first thing (a signal before it is ready means it
# exits without taking a task). exec resets the start-up traps to the default.
# Set PATH with tool priority
export PATH="/data/bin:/data/.mise/shims:/app/.mise/shims:$PATH"
# The gh shim goes first so every gh call, including Claude Code's Bash tool
# (it inherits this PATH), picks up the current token from GITHUB_TOKEN_FILE.
if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
  export PATH="/opt/roundtable/bin:$PATH"
fi

log "Phase 5: Starting claude-knight"
exec node dist/index.js
