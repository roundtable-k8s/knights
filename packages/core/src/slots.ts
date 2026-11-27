import { log } from "./logger.js";
import type { ParsedTask } from "./contract/index.js";
import type { TaskDelivery } from "./nats/index.js";

/** Concurrency slots (0-based) handed out to running tasks and reported on `task.started`. */
export class SlotPool {
  private readonly used = new Set<number>();

  /** Takes the lowest free slot. */
  acquire(): number {
    let slot = 0;
    while (this.used.has(slot)) slot++;
    this.used.add(slot);
    return slot;
  }

  /** Frees a slot. Releasing a slot that is not in use is a no-op. */
  release(slot: number): void {
    this.used.delete(slot);
  }

  /** Number of slots currently held. */
  inUse(): number {
    return this.used.size;
  }
}

/**
 * Runs `fn` holding a slot and always frees it, however `fn` ends (return or throw).
 * Everything that happens after the slot is taken belongs inside `fn`.
 */
export async function withSlot<T>(slots: SlotPool, fn: (slot: number) => Promise<T>): Promise<T> {
  const slot = slots.acquire();
  try {
    return await fn(slot);
  } finally {
    slots.release(slot);
  }
}

/** True when the task was published by this knight itself (case-insensitive `from` match; empty `from` never matches). */
export function isSelfEcho(task: Pick<ParsedTask, "taskId" | "from">, knightName: string): boolean {
  const self = !!task.from && task.from.toLowerCase() === knightName.toLowerCase();
  if (self) log.debug("Skipping self-echo", { taskId: task.taskId, from: task.from });
  return self;
}

/**
 * Fire-and-forget: runs `processTask` holding a slot (taken synchronously, so the next fetch sees it).
 * If the handler throws, the error is logged and the delivery acked; the slot is always freed.
 */
export function runInSlot(slots: SlotPool, delivery: TaskDelivery, processTask: (delivery: TaskDelivery, slot: number) => Promise<unknown>): void {
  void withSlot(slots, (slot) => processTask(delivery, slot)).catch((e) => {
    log.error("Task handler crashed", { taskId: delivery.task.taskId, error: e instanceof Error ? e.message : String(e) });
    delivery.ack();
  });
}
