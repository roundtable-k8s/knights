/**
 * Active-task counter whose change hook runs before the count is updated.
 *
 * `onChange` reports the new value to the gauges and the task-count setter. If it throws, the
 * count keeps its old value, so it stays equal to the number of tasks truly open. (Assigning
 * first and reporting second would leave the count one too high after a throwing setter, and
 * the scope's onClose never runs for a failed onOpen, so shutdown would wait for it.)
 */
export interface ActiveCounter {
  get(): number;
  increment(): void;
  decrement(): void;
}

export function createActiveCounter(onChange: (n: number) => void): ActiveCounter {
  let count = 0;
  const set = (next: number): void => {
    onChange(next);
    count = next;
  };
  return {
    get: () => count,
    increment: () => set(count + 1),
    decrement: () => set(count - 1),
  };
}
