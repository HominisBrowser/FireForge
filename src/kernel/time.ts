// SPDX-License-Identifier: EUPL-1.2

/**
 * The one awaitable delay. Built on the global `setTimeout` so fake timers
 * reach it. The timer holds the event loop open unless `unref` is set: an
 * unref'd delay between a SIGTERM and its escalation would let Node exit
 * mid-grace.
 *
 * @param ms - Milliseconds to wait
 * @param options - `unref` for a delay that must not keep the process alive
 */
export function sleep(ms: number, options: { unref?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (options.unref === true) timer.unref();
  });
}

/**
 * Formats a duration as `12s`, `3m 12s` or `2h 05m`.
 *
 * @param ms - Milliseconds; negative input reads as zero
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Whether `promise` settles (either way) within `ms`.
 *
 * @param promise - The work being waited on
 * @param ms - The bound
 */
export async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  const settled = promise.then(
    () => true,
    () => true
  );
  try {
    return await Promise.race([settled, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Maps `items` with at most `limit` calls in flight, preserving order. On a
 * failure it stops scheduling, waits for what already started, then rejects,
 * so the caller can clean up safely.
 *
 * @param items - Inputs
 * @param limit - Maximum concurrent calls
 * @param fn - The mapper
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const state: { failure?: { error: unknown } } = {};
  const worker = async (): Promise<void> => {
    while (state.failure === undefined) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error: unknown) {
        state.failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  if (state.failure !== undefined) throw state.failure.error;
  return results;
}
