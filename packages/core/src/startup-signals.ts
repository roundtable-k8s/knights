import { log } from "./logger.js";

/**
 * SIGTERM/SIGINT from the first line of main.
 *
 * In a pod the runtime is PID 1, and the kernel drops a signal to PID 1 that has no
 * handler. The full shutdown (createShutdown) needs the NATS connection and the pull
 * loop, so it can only be wired once the knight is ready; a pod deleted before that
 * used to ignore SIGTERM, start up, take tasks for the whole grace period and lose
 * the one it was running at SIGKILL. These handlers are installed before any network
 * call: a signal before ready() closes what is open and exits 0 without pulling; a
 * signal after ready() runs the full shutdown.
 */
export interface StartupSignals {
  /** The first termination signal since the handlers were installed, or null. Guard for the pull loop. */
  requested(): string | null;
  /**
   * The knight is ready: hand later signals to the full shutdown. Returns false when a
   * signal already arrived; the caller must then not start pulling (the start-up exit is
   * already running).
   */
  ready(shutdown: (signal: string) => Promise<void>): boolean;
}

export interface StartupSignalOptions {
  /** Close what start-up opened so far (NATS, health server, telemetry). Errors are logged. */
  cleanup?(): Promise<void> | void;
  exit(code: number): void;
  /** Exit even if cleanup hangs (default 5s). */
  cleanupTimeoutMs?: number;
  target?: Pick<NodeJS.Process, "on">;
}

export function installStartupSignalHandlers(opts: StartupSignalOptions): StartupSignals {
  const target = opts.target ?? process;
  let requested: string | null = null;
  let shutdown: ((signal: string) => Promise<void>) | null = null;

  let startupExit: Promise<void> | null = null;

  const onSignal = (signal: string) => {
    requested ??= signal;
    if (shutdown) {
      void shutdown(signal); // idempotent itself
      return;
    }
    startupExit ??= exitDuringStartup(signal); // a second signal while exiting changes nothing
  };

  async function exitDuringStartup(signal: string): Promise<void> {
    log.info("Shutdown signal received during start-up — exiting without taking tasks", { signal });
    const timeoutMs = opts.cleanupTimeoutMs ?? 5000;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        log.warn("Start-up cleanup timed out — exiting anyway", { timeoutMs });
        resolve();
      }, timeoutMs);
    });
    const cleanup = Promise.resolve()
      .then(() => opts.cleanup?.())
      .catch((e) => log.error("Start-up cleanup error", { error: String(e) }));
    await Promise.race([cleanup, timedOut]);
    clearTimeout(timer);
    log.info("Shutdown complete");
    opts.exit(0);
  }

  target.on("SIGTERM", () => onSignal("SIGTERM"));
  target.on("SIGINT", () => onSignal("SIGINT"));

  // A signal that arrived before this ran was recorded by scripts/early-signals.mjs (--import preload).
  const early = (globalThis as { __rtEarlySignal?: string }).__rtEarlySignal;
  if (early) onSignal(early);

  return {
    requested: () => requested,
    ready(fn) {
      if (requested !== null) return false;
      shutdown = fn;
      return true;
    },
  };
}
