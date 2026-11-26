#!/bin/bash
# entrypoint.sh — Pi-Knight startup with PVC-native Nix
#
# Architecture:
#   - Nix tools come from the operator's tools image, mounted read-only at /nix
#     (profile at $KNIGHT_NIX_PROFILE, normally /nix/profile). Nothing is
#     installed or built at start-up.
#
# Mount requirements:
#   /nix    → tools image (read-only image volume, optional)
#   /data   → PVC (workspace, memory, mise tools); $KNIGHT_DATA_DIR overrides
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
# Same data root and models path as the runtime's dataPaths().
DATA_DIR="${KNIGHT_DATA_DIR:-/data}"
MODELS_JSON="${MODELS_JSON_PATH:-$DATA_DIR/models.json}"
# shellcheck source=seed-data.sh
. "$(dirname "$0")/seed-data.sh"
rt_seed_workspace "$DATA_DIR" /app/defaults /config

rt_phase_mark "Phase 1"

# ──────────────────────────────────────────────────────────────────
# Phase 1.5: Optional Pi model provider bootstrap
# ──────────────────────────────────────────────────────────────────
# Allows per-knight native provider configuration (for example Ollama)
# without baking models.json into the image. Written to the models path
# ($MODELS_JSON_PATH, else $DATA_DIR/models.json) — where ModelRuntime reads it.
rt_write_models_json "$MODELS_JSON"

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
# Phase 4: Mise tools (if any per-knight config)
# ──────────────────────────────────────────────────────────────────
if [ -f /config/mise.toml ] && command -v mise >/dev/null 2>&1; then
  log "Phase 4: Mise tools"
  rt_mise() { /app/scripts/mise-init.sh 2>&1 | sed 's/^/  /'; }
  rt_run rt_mise || log "  WARNING: mise init failed (non-fatal)"
else
  log "Phase 4: No mise config — skipping"
fi

rt_phase_mark "Phase 4"

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
# shellcheck source=github/configure-git.sh
. "$(dirname "$0")/github/configure-git.sh"
rt_phase_mark "Phase 4.9"

# Phase 5: Start the knight
# ──────────────────────────────────────────────────────────────────
# exec: the runtime replaces this shell as PID 1 and gets SIGTERM directly; it
# installs its own handlers first thing (a signal before it is ready means it
# exits without taking a task). exec resets the start-up traps to the default.
# Set PATH with tool priority
export PATH="$DATA_DIR/bin:$DATA_DIR/.mise/shims:/app/.mise/shims:$PATH"
# The gh shim goes first so every gh call (including the agent's Bash tool)
# picks up the current token from GITHUB_TOKEN_FILE.
if [ -n "${GITHUB_TOKEN_FILE:-}" ]; then
  export PATH="/opt/roundtable/bin:$PATH"
fi

log "Phase 5: Starting pi-knight"
exec node dist/index.js
