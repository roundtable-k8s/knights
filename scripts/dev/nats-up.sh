#!/usr/bin/env bash
# Start a local JetStream nats-server for running a knight without a cluster, and create
# what the operator would: the task and results streams and the knight's durable pull consumer.
# Runs in the foreground until Ctrl-C; the store is a temp dir, removed on exit.
#
#   scripts/dev/nats-up.sh                       # or: npm run dev:nats
#   KNIGHT_NAME=dev NATS_PORT=4222 scripts/dev/nats-up.sh
#
# Environment (all optional):
#   KNIGHT_NAME        knight the consumer is for (<KNIGHT_NAME>-consumer)     default: dev
#   SUBSCRIBE_TOPICS   consumer filter, comma separated   default: fleet-a.tasks.<knight lowercased>.>
#   NATS_PORT          client port                                            default: 4222
#   NATS_SERVER_BIN    nats-server binary                                     default: nats-server on PATH
#   NATS_SETUP         "cli" (nats CLI) or "tsx" (scripts/dev/nats-setup.ts)  default: cli if `nats` is on PATH
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

knight="${KNIGHT_NAME:-dev}"
lower="$(printf '%s' "$knight" | tr '[:upper:]' '[:lower:]')"
topics="${SUBSCRIBE_TOPICS:-fleet-a.tasks.${lower}.>}"
port="${NATS_PORT:-4222}"
url="nats://127.0.0.1:${port}"
server_bin="${NATS_SERVER_BIN:-nats-server}"
tasks_stream="fleet_a_tasks"
results_stream="fleet_a_results"

if ! command -v "$server_bin" >/dev/null 2>&1; then
  echo "nats-up: nats-server not found (install it, or set NATS_SERVER_BIN)" >&2
  exit 1
fi
setup="${NATS_SETUP:-}"
if [[ -z "$setup" ]]; then
  if command -v nats >/dev/null 2>&1; then setup=cli; else setup=tsx; fi
fi

store="$(mktemp -d "${TMPDIR:-/tmp}/knights-nats.XXXXXX")"
server_pid=""
cleanup() {
  if [[ -n "$server_pid" ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  rm -rf "$store"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

"$server_bin" -js -a 127.0.0.1 -p "$port" -sd "$store" &
server_pid=$!

# Wait for the client port.
for _ in $(seq 1 100); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then break; fi
  if ! kill -0 "$server_pid" 2>/dev/null; then echo "nats-up: nats-server exited" >&2; exit 1; fi
  sleep 0.1
done

if [[ "$setup" == "cli" ]]; then
  stream() { # name subject
    if ! nats --server "$url" stream info "$1" >/dev/null 2>&1; then
      nats --server "$url" stream add "$1" --subjects "$2" --storage file --defaults >/dev/null
    fi
  }
  stream "$tasks_stream" "fleet-a.tasks.>"
  stream "$results_stream" "fleet-a.results.>"
  if ! nats --server "$url" consumer info "$tasks_stream" "${knight}-consumer" >/dev/null 2>&1; then
    filters=()
    IFS=',' read -ra parts <<<"$topics"
    for t in "${parts[@]}"; do filters+=(--filter "$(echo "$t" | xargs)"); done
    # Same settings as subscribe() in packages/core/src/nats/index.ts.
    nats --server "$url" consumer add "$tasks_stream" "${knight}-consumer" --pull \
      --ack explicit --deliver all --max-deliver 1 --wait 30s --replay instant \
      "${filters[@]}" --defaults >/dev/null
  fi
  echo "streams $tasks_stream (fleet-a.tasks.>), $results_stream (fleet-a.results.>); consumer ${knight}-consumer on $topics"
else
  (cd "$root" && npx --no-install tsx scripts/dev/nats-setup.ts --url "$url" --knight "$knight" --topics "$topics" \
    --tasks-stream "$tasks_stream" --results-stream "$results_stream")
fi

cat <<MSG
nats-up: ready on $url (store $store). Ctrl-C to stop.
  knight env: NATS_URL=$url KNIGHT_NAME=$knight SUBSCRIBE_TOPICS='$topics'
  send a task: npm run dev:send -- "Say hello." --knight $knight
MSG

wait "$server_pid"
