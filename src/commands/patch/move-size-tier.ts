// SPDX-License-Identifier: EUPL-1.2
/**
 * Names a patch-size tier change in a move's lint refusal.
 *
 * `large-patch-lines` judges a patch by its tier: a patch of test files
 * only is held to the test tier, everything else to the general tier
 * (with test lines split out under `addedCode`). A move that takes a
 * source's last product file out turns it into a test-only patch, and the
 * test tier then counts every line against its own ceiling, where a
 * `share: "test"` waiver no longer applies. A plain size error would hide
 * that reordering the moves (tests first) fixes it, so the wrapper below appends which tier the patch moves into, its count and the
 * ceiling that count is held to.
 */

import {
  getPatchSizeThresholds,
  measurePatchSize,
  resolvePatchSizeTier,
} from '../../core/patch-lint-size.js';
import { GeneralError } from '../../errors/base.js';
import { runPatchLint, type RunPatchLintOptions } from '../export-shared.js';

/** One side of a move, linted on its post-transaction body. */
export interface MoveSideLintOptions extends RunPatchLintOptions {
  /** The patch's files before the move; absent for a patch the move creates. */
  filesBefore?: readonly string[];
  /** How the refusal names the patch (`source`, `destination`). */
  role: string;
}

/**
 * Describes a tier change that leaves the patch above the new tier's
 * `large-patch-lines` error ceiling, or returns undefined when the tier
 * does not change, the rule is waived, or the count fits.
 *
 * @param options - The side's lint options and its files before the move
 */
async function describeMoveTierChange(options: MoveSideLintOptions): Promise<string | undefined> {
  const { filesBefore, filesAffected, patchTier, ignoreChecks, config } = options;
  if (filesBefore === undefined || ignoreChecks?.has('large-patch-lines') === true) {
    return undefined;
  }
  const before = resolvePatchSizeTier(filesBefore, patchTier).tier;
  const after = resolvePatchSizeTier(filesAffected, patchTier).tier;
  if (before === after) return undefined;

  const measurement = await measurePatchSize(
    options.engineDir,
    options.diffContent,
    filesAffected,
    config
  );
  // Under `addedCode` a general-tier patch holds only its non-test lines to
  // the general ceiling (the test lines meet the test tier's).
  const count =
    measurement.metric === 'addedCode' && after === 'general'
      ? measurement.lines - measurement.testLines
      : measurement.lines;
  const limit = getPatchSizeThresholds(after, config).lines.error;
  if (count <= limit) return undefined;
  const advice =
    after === 'test'
      ? 'Move its test files out before its last product file (or in the same move), ' +
        'so it never stands as a test-only patch above that ceiling.'
      : 'Order the moves so it does not change tier while above that ceiling.';
  return `Tier change: the ${options.role} becomes ${after} tier (it was ${before} tier): ${count} lines against ${limit}. ${advice}`;
}

/**
 * Runs {@link runPatchLint} on one side of a move and, when the lint
 * refuses, appends {@link describeMoveTierChange}'s line to the refusal.
 *
 * @param options - The side's lint options, its files before the move and its role
 */
export async function runMoveSideLint(options: MoveSideLintOptions): Promise<void> {
  try {
    await runPatchLint(options);
  } catch (error: unknown) {
    if (!(error instanceof GeneralError)) throw error;
    const note = await describeMoveTierChange(options);
    if (note === undefined) throw error;
    throw new GeneralError(`${error.message}\n${note}`);
  }
}
