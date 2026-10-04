// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { mapWithConcurrency } from '../concurrency.js';

describe('mapWithConcurrency', () => {
  it('preserves input order in the result array', async () => {
    const items = [30, 5, 20, 1, 10];
    const results = await mapWithConcurrency(items, 2, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, item));
      return item * 2;
    });
    expect(results).toEqual([60, 10, 40, 2, 20]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      3,
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight -= 1;
      }
    );
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it('returns an empty array for empty input without invoking the mapper', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, () => {
      calls += 1;
      return Promise.resolve();
    });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('passes the item index to the mapper', async () => {
    const results = await mapWithConcurrency(['a', 'b', 'c'], 8, (item, index) =>
      Promise.resolve(`${item}${index}`)
    );
    expect(results).toEqual(['a0', 'b1', 'c2']);
  });

  it('propagates a mapper rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (item) =>
        item === 2 ? Promise.reject(new Error('boom')) : Promise.resolve(item)
      )
    ).rejects.toThrow('boom');
  });

  it('handles a limit larger than the item count', async () => {
    const results = await mapWithConcurrency([1, 2], 16, (item) => Promise.resolve(item + 1));
    expect(results).toEqual([2, 3]);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects invalid limit %s', async (limit) => {
    await expect(mapWithConcurrency([1], limit, (item) => Promise.resolve(item))).rejects.toThrow(
      RangeError
    );
  });

  it('settles started writes before rejecting and stops scheduling more work', async () => {
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: number[] = [];
    const written: number[] = [];
    const failure = new Error('copy failed');
    let settled = false;
    const outcome = mapWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) throw failure;
      await pending;
      written.push(item);
      return item;
    }).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    release();
    expect(await outcome).toBe(failure);
    expect(written).toEqual([1]);
    expect(started).toEqual([0, 1]);
  });

  it('propagates even undefined rejections after settlement', async () => {
    // A foreign callback can reject without an Error; still stop and propagate it.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const rejectWithoutReason = (): Promise<never> => Promise.reject(undefined);
    await expect(mapWithConcurrency([1], 1, rejectWithoutReason)).rejects.toBeUndefined();
  });

  it('preserves the first failure when another started operation also fails', async () => {
    const first = new Error('original copy failure');
    const later = new Error('another copy failed during cleanup');
    const started: number[] = [];
    await expect(
      mapWithConcurrency([0, 1, 2], 2, (item) => {
        started.push(item);
        return Promise.reject(item === 0 ? first : later);
      })
    ).rejects.toBe(first);
    expect(started).toEqual([0, 1]);
  });
});
