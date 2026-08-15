/**
 * Bounded-concurrency helpers shared by commands that fan out per-file IO
 * (status classification, import's unmanaged-dirty guard, re-export scans,
 * the dry-run purity guard). Kept deliberately tiny: one order-preserving
 * mapper, no queues, no cancellation.
 */

/** Maps items with at most `limit` in-flight promises. Preserves order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
