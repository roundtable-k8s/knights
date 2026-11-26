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
