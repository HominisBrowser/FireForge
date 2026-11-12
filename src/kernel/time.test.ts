// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { formatDuration, mapLimit, settlesWithin, sleep } from './time.js';

describe('formatDuration', () => {
  it.each([
    [0, '0s'],
    [-5, '0s'],
    [59_400, '59s'],
    [192_000, '3m 12s'],
    [7_500_000, '2h 05m'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatDuration(ms)).toBe(expected);
  });
});

describe('settlesWithin', () => {
  it('is true for a promise that settles either way in time, false for one that does not', async () => {
    await expect(settlesWithin(Promise.resolve(1), 50)).resolves.toBe(true);
    await expect(settlesWithin(Promise.reject(new Error('x')), 50)).resolves.toBe(true);
    await expect(settlesWithin(sleep(200), 10)).resolves.toBe(false);
  });
});

describe('mapLimit', () => {
  it('preserves order and never exceeds the limit', async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 3, 2, 4], 2, async (value) => {
      running += 1;
      peak = Math.max(peak, running);
      await sleep(value);
      running -= 1;
      return value * 10;
    });
    expect(results).toEqual([50, 10, 30, 20, 40]);
    expect(peak).toBe(2);
  });

  it('stops scheduling after a failure and waits for what already started', async () => {
    const started: number[] = [];
    let finished = 0;
    await expect(
      mapLimit([0, 1, 2, 3, 4, 5], 2, async (value) => {
        started.push(value);
        await sleep(5);
        finished += 1;
        if (value === 1) throw new Error('second failed');
      })
    ).rejects.toThrow('second failed');
    expect(finished).toBe(started.length);
    expect(started.length).toBeLessThan(6);
  });
});
