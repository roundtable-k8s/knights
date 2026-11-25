#!/bin/bash
# startup-signals.sh — SIGTERM/SIGINT handling for the knight entrypoints.
#
# Sourced as the first statement of both entrypoint.sh scripts (copied next to
# them in each image). The entrypoint runs as PID 1, and the kernel drops a
# signal to PID 1 that has no handler: without this trap a pod deleted during
# start-up ignores SIGTERM, finishes starting, takes tasks for the whole grace
# period and loses the one it is running when it is SIGKILLed.
#
# Bash runs a trap only between commands, so a long phase must go through
# rt_run: it runs the phase as a background job and waits for it, and `wait`
# returns as soon as a trapped signal arrives. The handler stops that job and
# exits 0 before the runtime is ever started.

RT_PHASE_PID=""

rt_startup_term() {
  # A second signal while stopping changes nothing.
  trap '' TERM INT
  echo "[entrypoint] $(date '+%H:%M:%S') $1 received during start-up — exiting before the knight starts (no tasks taken)"
  if [ -n "$RT_PHASE_PID" ]; then
    kill -TERM "$RT_PHASE_PID" 2>/dev/null || true
  fi
  exit 0
}

trap 'rt_startup_term SIGTERM' TERM
trap 'rt_startup_term SIGINT' INT

# rt_run CMD [ARGS...] — run a slow start-up phase (a command or a shell
# function) so a termination signal interrupts it at once. Returns the phase's
# exit status. A function runs in a subshell: only its file system effects stay.
rt_run() {
  "$@" &
  RT_PHASE_PID=$!
  local rc=0
  wait "$RT_PHASE_PID" || rc=$?
  RT_PHASE_PID=""
  return "$rc"
}

# rt_phase_mark LABEL — log one line with the seconds spent since the previous
# mark (or since the entrypoint started), so a slow start shows in the pod log.
RT_PHASE_START="$SECONDS"
rt_phase_mark() {
  echo "[entrypoint] $(date '+%H:%M:%S') $1 took $((SECONDS - RT_PHASE_START))s"
  RT_PHASE_START="$SECONDS"
}
