// early-signals.mjs — preloaded with `node --import` by the entrypoints.
// Node is PID 1 and has no SIGTERM/SIGINT handler while the static imports of
// dist/index.js load, so the kernel would drop a signal sent in that window.
// Record the first one; installStartupSignalHandlers honours it (see startup-signals.ts).
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    globalThis.__rtEarlySignal ??= signal;
  });
}
