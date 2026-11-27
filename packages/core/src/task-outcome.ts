import { log } from "./logger.js";
import type { TaskResult } from "./contract/index.js";
import { publishResult } from "./nats/index.js";

export interface TaskOutcome {
  taskId: string;
  /** Records the task metrics. Runs before the publish; a throw is logged and swallowed. */
  record: () => void;
  /** Builds the result payload; called once, after `record`. */
  payload: () => TaskResult;
  /** Trace headers captured while the task span was active; see PublishResultOptions.traceHeaders. */
  traceHeaders?: Record<string, string>;
  /** Defaults to `publishResult` (with `traceHeaders`); injectable for tests. */
  publish?: (taskId: string, result: TaskResult, opts: { traceHeaders?: Record<string, string> }) => Promise<void>;
  /** Called once when the publish fails (the result is lost). */
  onPublishFailed: () => void;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Record metrics first, then publish the result. A result that cannot be published must not lose
 * the metrics or turn a finished task into a made-up failure (#91), so this never rejects.
 */
export async function publishTaskOutcome(o: TaskOutcome): Promise<void> {
  const { taskId, record, payload, traceHeaders, onPublishFailed } = o;
  const publish = o.publish ?? publishResult;
  try {
    record();
  } catch (e) {
    log.error("Failed to record task metrics", { taskId, error: errText(e) });
  }
  try {
    await publish(taskId, payload(), { traceHeaders });
  } catch (e) {
    log.error("Failed to publish task result — result lost", { taskId, error: errText(e) });
    try {
      onPublishFailed();
    } catch (e2) {
      log.error("onPublishFailed threw", { taskId, error: errText(e2) });
    }
  }
}
