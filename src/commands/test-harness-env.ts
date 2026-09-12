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
 * Resolves the `--shuffle` seed: a fresh one when the flag was bare, the
 * operator's when it carried one. Mach's `--shuffle` is an UNSEEDED
 * Fisher–Yates over `Math.random` (SimpleTest/setup.js), so a red found by
 * shuffling could not be reproduced. FireForge draws the seed, exports it
 * as `FIREFORGE_SHUFFLE_SEED` for harness code that reorders inside a file,
 * prints it, and stamps it on the verdict line.
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
  info(`Test order shuffle: seed=${seed} (reproduce with "fireforge test --shuffle=${seed}")`);
  return seed;
}
