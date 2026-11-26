#!/bin/bash
# seed-data.sh — Phase 1 / 1.5 of the pi-knight entrypoint, as sourced functions
# so a test can run them against a temp KNIGHT_DATA_DIR. Expects `log` to exist.
#
# Paths follow the runtime's dataPaths() (packages/pi-knight/src/config.ts):
#   DATA_DIR    = $KNIGHT_DATA_DIR, else /data
#   MODELS_JSON = $MODELS_JSON_PATH, else $DATA_DIR/models.json

# rt_seed_workspace DATA_DIR DEFAULTS_DIR CONFIG_DIR
rt_seed_workspace() {
  local data_dir="$1" defaults_dir="$2" config_dir="$3" f fname config_hash stored_hash
  mkdir -p "$data_dir/memory" "$data_dir/session-notes" "$data_dir/scratch"

  # Seed operational files from image defaults (only if missing on PVC)
  if [ -d "$defaults_dir" ]; then
    for f in "$defaults_dir"/*.md; do
      [ -e "$f" ] || continue
      fname=$(basename "$f")
      [ ! -f "$data_dir/$fname" ] && cp "$f" "$data_dir/$fname" && log "  Seeded $fname"
    done
  fi

  # Sync personality files from ConfigMap → PVC (hash-gated)
  # Only overwrites when ConfigMap content actually changed.
  # Knights can self-modify data files, but CRD-driven changes win.
  mkdir -p "$data_dir/.config-hashes"
  for f in SOUL.md IDENTITY.md TOOLS.md; do
    if [ -f "$config_dir/$f" ]; then
      config_hash=$(md5sum "$config_dir/$f" | cut -d' ' -f1)
      stored_hash=""
      [ -f "$data_dir/.config-hashes/$f" ] && stored_hash=$(cat "$data_dir/.config-hashes/$f")
      if [ "$config_hash" != "$stored_hash" ]; then
        cp "$config_dir/$f" "$data_dir/$f"
        echo "$config_hash" > "$data_dir/.config-hashes/$f"
        if [ -z "$stored_hash" ]; then
          log "  Seeded $f from ConfigMap"
        else
          log "  Updated $f from ConfigMap (hash changed)"
        fi
      fi
    fi
  done
}

# rt_write_models_json MODELS_JSON — write PI_MODELS_JSON_B64 / PI_MODELS_JSON to
# the models path. An unwritable path (for example a read-only ConfigMap mount)
# is a warning, not a failure.
rt_write_models_json() {
  local target="$1"
  if [ -z "${PI_MODELS_JSON_B64:-}" ] && [ -z "${PI_MODELS_JSON:-}" ]; then
    log "Phase 1.5: No custom Pi model config — skipping"
    return 0
  fi
  if ! mkdir -p "$(dirname "$target")" 2>/dev/null; then
    log "  WARNING: cannot create $(dirname "$target") — not writing PI_MODELS_JSON* (non-fatal)"
    return 0
  fi
  if [ -n "${PI_MODELS_JSON_B64:-}" ]; then
    if printf '%s' "$PI_MODELS_JSON_B64" | base64 -d > "$target" 2>/dev/null; then
      log "Phase 1.5: Wrote $target from PI_MODELS_JSON_B64"
    else
      log "  WARNING: cannot write $target — skipping PI_MODELS_JSON_B64 (non-fatal)"
    fi
  elif printf '%s\n' "$PI_MODELS_JSON" > "$target" 2>/dev/null; then
    log "Phase 1.5: Wrote $target from PI_MODELS_JSON"
  else
    log "  WARNING: cannot write $target — skipping PI_MODELS_JSON (non-fatal)"
  fi
}
