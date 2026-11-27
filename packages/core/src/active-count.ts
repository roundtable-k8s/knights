/**
 * Active-task counter: the count is assigned first, then `onChange` reports it.
 *
 * The count always reflects reality; the gauge/setter is best-effort. If `onChange` throws, the
 * error propagates after the count has been updated, so a throwing setter cannot leave the count
 * one too high (or low) while the task really opened or closed.
 */
export interface ActiveCounter {
  get(): number;
  increment(): void;
  decrement(): void;
}

export function createActiveCounter(onChange: (n: number) => void): ActiveCounter {
  let count = 0;
  const set = (next: number): void => {
    count = next;
    onChange(next);
  };
  return {
    get: () => count,
    increment: () => set(count + 1),
    decrement: () => set(count - 1),
  };
}
