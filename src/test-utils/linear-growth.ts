// SPDX-License-Identifier: EUPL-1.2
import { expect } from 'vitest';

/**
 * How much larger the second input is than the first.
 */
const SIZE_FACTOR = 16;

/**
 * Upper bound on time(16N) / time(N). Linear growth sits at ~16, quadratic
 * at ~256. Four times the linear figure leaves generous room for scheduler
 * noise and memory-hierarchy effects without coming close to admitting the
 * old implementations.
 */
const MAX_GROWTH_RATIO = 64;

/**
 * Below this, the large run finished so fast that the ratio is timer noise
 * rather than algorithmic growth, so treat it as trivially linear. A quadratic
 * scan at these sizes cost seconds, not single-digit milliseconds.
 */
const NOISE_FLOOR_MS = 5;

const BASE_N = 10_000;

function bestOfMs(run: () => void, reps = 3): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < reps; i++) {
    const start = performance.now();
    run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

/**
 * Times `run` on inputs of size N and {@link SIZE_FACTOR}N (inputs are built
 * outside the timed region) and asserts the growth is linear-ish. `run` must return the same
 * shape at either size. Behaviour is pinned separately.
 */
export function expectLinearGrowth<T>(build: (n: number) => T, run: (input: T) => void): void {
  const small = build(BASE_N);
  const large = build(BASE_N * SIZE_FACTOR);
  // Warm-up: JIT and regex compilation must not land on the small run.
  run(small);
  run(large);
  const smallMs = bestOfMs(() => {
    run(small);
  });
  const largeMs = bestOfMs(() => {
    run(large);
  });
  if (largeMs < NOISE_FLOOR_MS) return;
  const ratio = largeMs / smallMs;
  expect(
    ratio,
    `time(${SIZE_FACTOR}N)=${largeMs.toFixed(2)}ms / time(N)=${smallMs.toFixed(2)}ms`
  ).toBeLessThan(MAX_GROWTH_RATIO);
}
