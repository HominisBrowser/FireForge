// SPDX-License-Identifier: EUPL-1.2
/**
 * The `file-too-large` thresholds and their rendered message.
 *
 * Its own module for two reasons: the config validator needs the defaults
 * to validate an override triple against the merged result, and importing
 * `patch-lint.ts` from `config-validate.ts` for a constant would draw an
 * import edge (and a cycle) between the rule bodies and config parsing.
 *
 * On the vocabulary: the bands were `notice` / `warning` / `error` with the
 * middle one described as a "soft limit". That description is false under
 * the posture FireForge itself recommends for a release gate,
 * `--max-warnings 0`, where a warning is a hard failure, so a file at 751
 * lines failed a gate with a message calling 750 soft. The message below
 * says what the band is (a warning) and what a zero-warning gate does with
 * it, and the thresholds are now tunable, so a project whose file-size
 * policy differs has a dial instead of an argument. The notice band is the
 * design target: advisory, and its message says so rather than borrowing
 * the warning band's gate sentence.
 */

import type { PatchLintFileSizeThresholds, PatchLintFileSizeTier } from '../types/config.js';

/** A fully resolved threshold triple. */
export interface ResolvedFileSizeTier {
  notice: number;
  warning: number;
  error: number;
}

/** Built-in defaults, per file class. */
export const DEFAULT_FILE_SIZE_THRESHOLDS: {
  general: ResolvedFileSizeTier;
  test: ResolvedFileSizeTier;
} = {
  general: { notice: 500, warning: 750, error: 900 },
  test: { notice: 1200, warning: 1400, error: 1600 },
};

/**
 * Merges a configured override over the defaults for one file class.
 *
 * @param overrides - The `patchLint.fileSizeThresholds` block, if any
 * @param isTest - Whether the file counts as a test file
 * @returns The effective triple for this file
 */
export function resolveFileSizeThresholds(
  overrides: PatchLintFileSizeThresholds | undefined,
  isTest: boolean
): ResolvedFileSizeTier {
  const key = isTest ? 'test' : 'general';
  const configured: PatchLintFileSizeTier = overrides?.[key] ?? {};
  return { ...DEFAULT_FILE_SIZE_THRESHOLDS[key], ...configured };
}

/**
 * Renders the `file-too-large` message for a given band.
 *
 * Each band says what it means for a gate. A notice is over the design
 * target and advisory: it never fails `--max-warnings 0`, and saying it
 * did once got a test suite split for nothing. A warning is what a
 * zero-warning gate fails on, so it names that and the dial. Only the
 * error band suggests splitting, because a test-file split pushes against
 * one suite per subject and should not be the default advice below it.
 * Every band names the unit, which matters once `fileSizeMetric` makes
 * code lines a choice.
 */
export function formatFileTooLargeMessage(args: {
  label: string;
  lineCount: number;
  unit: 'lines' | 'code lines';
  thresholds: ResolvedFileSizeTier;
  band: 'notice' | 'warning' | 'error';
  verb: string;
}): string {
  const { label, lineCount, unit, thresholds, band, verb } = args;
  const measured = `${label} has ${lineCount} ${unit}`;
  if (band === 'error') {
    return `${measured} (error threshold: ${thresholds.error}). Consider ${verb}.`;
  }
  const limits = `(warning threshold: ${thresholds.warning}, error threshold: ${thresholds.error})`;
  if (band === 'notice') {
    return (
      `${measured}, over the design target of ${thresholds.notice} ${limits}. ` +
      'Advisory; does not fail --max-warnings 0.'
    );
  }
  return (
    `${measured} ${limits}. ` +
    'Reported as a warning, which a gate running --max-warnings 0 treats as a failure; ' +
    'tune "patchLint.fileSizeThresholds" if these limits are wrong for this project.'
  );
}
