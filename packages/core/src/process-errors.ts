/**
 * Process-level error handlers. A stray rejection or exception would otherwise print a raw stack
 * trace to stderr, outside the JSON log, and the in-flight tasks would be reported `lost` with no
 * hint of which ones were running. Log it as a structured error naming them, then exit 1 as before.
 */
import { log } from "./logger.js";
import { listInflight } from "./activity.js";

export interface ProcessErrorOptions {
  exit?: (code: number) => void;
  target?: Pick<NodeJS.Process, "on">;
}

function describe(err: unknown): { error: string; stack?: string } {
  if (err instanceof Error) return { error: err.message, ...(err.stack ? { stack: err.stack } : {}) };
  return { error: String(err) };
}

export function installProcessErrorHandlers(opts: ProcessErrorOptions = {}): void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const target = opts.target ?? process;
  let exiting = false;
  const handle = (msg: string) => (err: unknown): void => {
    if (exiting) return;
    exiting = true;
    log.error(msg, { ...describe(err), inflight: listInflight().map((t) => t.taskId) });
    exit(1);
  };
  target.on("unhandledRejection", handle("Unhandled promise rejection"));
  target.on("uncaughtException", handle("Uncaught exception"));
}
