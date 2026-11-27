import { log, publishTaskOutcome, type ParsedTask, type TaskActivity, type TaskOutcome, type TaskScope } from "@roundtable/knight-core";
import type { KnightConfig } from "./config.js";
import { buildResultPayload, reserveRefusedOutcome } from "./result.js";
import { recordPublishFailed, recordReserveRefusal } from "./task-metrics.js";

export interface ReserveRefusalArgs {
  parsed: ParsedTask;
  /** Closed after the refusal is published: this is the one ack of the task. */
  scope: Pick<TaskScope, "close">;
  reason: string | undefined;
  config: KnightConfig;
  /** Task start time (ms since epoch), for the result's duration. */
  started: number;
  activity?: Pick<TaskActivity, "finished">;
  /** Injectable for tests; defaults to publishResult. */
  publish?: TaskOutcome["publish"];
}

/**
 * Publish the result of a task the plan reserve refused before Claude Code was started,
 * then ack it through its scope. Never throws: a failed publish is counted, not rethrown.
 */
export async function refuseForReserve(args: ReserveRefusalArgs): Promise<void> {
  const { parsed, scope, reason, config, started, activity, publish } = args;
  log.warn("Task refused: plan reserve", { taskId: parsed.taskId, reason });
  activity?.finished({ success: false, error: `Task refused: ${reason}`, errorClass: "model_error", cost: 0 });
  await publishTaskOutcome({
    taskId: parsed.taskId,
    record: recordReserveRefusal,
    payload: () =>
      buildResultPayload(reserveRefusedOutcome(reason, config), {
        taskId: parsed.taskId,
        knight: config.knightName,
        durationMs: Date.now() - started,
        parsed,
      }),
    onPublishFailed: recordPublishFailed,
    publish,
  });
  scope.close(); // idempotent: clears timers, then acks once
}
