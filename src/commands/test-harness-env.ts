// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-feature environment and argument contracts `fireforge test` exports to
 * the harness process: the perf-sample artifact path and the seeded
 * test-order shuffle. Split out of `test.ts` to keep the command body inside
 * its file budget.
 */
import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { info } from '../utils/logger.js';
import type { TestSuite } from './test-run.js';
import { setVerdictRunAttribute } from './test-verdict.js';

/**
 * Builds the perf-sample env contract for the harness run:
 * `--perf-samples <path>` exports `<BINARYNAME>_PERF_SAMPLE_JSON` naming the
 * artifact file a budget checker consumes after the run.
 */
export function buildPerfSampleEnv(
  projectRoot: string,
  binaryName: string,
  perfSamples: string | undefined
): Record<string, string> | undefined {
  if (!perfSamples) return undefined;
  const envName = `${binaryName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_PERF_SAMPLE_JSON`;
  const artifactPath = resolve(projectRoot, perfSamples);
  info(`Perf sample contract: ${envName}=${artifactPath}`);
  return { [envName]: artifactPath };
}

/**
 * Merges the per-feature harness env contracts into one map, or `undefined`
 * when no feature exported anything (so `TestRunContext.env` stays absent).
 */
export function mergeHarnessEnv(
  ...parts: (Record<string, string> | undefined)[]
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  for (const part of parts) {
    if (part) Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolves the seed for FireForge's isolated shard order and exports it for
 * custom in-file task code. Native mach file shuffling remains unseeded;
 * replaying this seed guarantees only the FireForge shard permutation.
 *
 * Mochitest-only: the xpcshell harness has no shuffle, and generic `mach
 * test` dispatch would forward the flag to every suite it fans out to.
 */
export function resolveShuffleSeed(
  shuffle: number | boolean | undefined,
  suite: TestSuite
): number | undefined {
  if (shuffle === undefined || shuffle === false) return undefined;
  if (suite !== 'mochitest') {
    throw new GeneralError(
      "--shuffle forwards the mochitest harness's file-order shuffle; the xpcshell harness has " +
        'none, and generic `mach test` dispatch would hand it to every suite. Narrow the paths to ' +
        'browser-chrome/mochitest files (and drop --generic-mach-test).'
    );
  }
  const seed = shuffle === true ? randomInt(1, 2 ** 31 - 1) : shuffle;
  setVerdictRunAttribute('shuffle', String(seed));
  info(
    `Test shard order: seed=${seed} (replay with "fireforge test --shuffle=${seed}"). ` +
      'Native harness file shuffle remains unseeded.'
  );
  return seed;
}

/** Returns a deterministic Fisher–Yates permutation without mutating the selection. */
export function shuffleTestGroups<T>(groups: readonly T[], seed: number): T[] {
  const shuffled = [...groups];
  // Hash the decimal seed so every accepted safe integer contributes, rather
  // than silently discarding its high bits in the 32-bit PRNG.
  let state = 2166136261;
  for (const character of String(seed))
    state = Math.imul(state ^ character.charCodeAt(0), 16777619);
  state = state >>> 0 || 1;
  for (let index = shuffled.length - 1; index > 0; index--) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    const destination = Math.floor(((state >>> 0) / 2 ** 32) * (index + 1));
    // Both indexes are bounded by the array length, including under
    // noUncheckedIndexedAccess; T may itself contain undefined.
    const selected = shuffled[index] as T;
    shuffled[index] = shuffled[destination] as T;
    shuffled[destination] = selected;
  }
  return shuffled;
}
