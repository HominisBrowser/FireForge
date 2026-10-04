/**
 * Bounded-concurrency helpers shared by commands that fan out per-file IO
 * (status classification, import's unmanaged-dirty guard, re-export scans,
 * the dry-run purity guard). On failure, stop scheduling new items and await
 * every started operation before rejecting, so callers can safely clean up.
 */

/** Maps items with at most `limit` in-flight promises. Preserves order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError('Concurrency limit must be a positive integer');
  }
  const results = new Array<R>(items.length);
  let next = 0;
  const state: { failure?: { error: unknown } } = {};
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!state.failure) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await fn(items[index] as T, index);
      } catch (error: unknown) {
        state.failure ??= { error };
      }
    }
  });
  await Promise.all(workers);
  if (state.failure) throw state.failure.error;
  return results;
}
