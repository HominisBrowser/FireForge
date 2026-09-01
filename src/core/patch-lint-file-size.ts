// SPDX-License-Identifier: EUPL-1.2
/**
 * The `file-too-large` thresholds and their rendered message.
 *
 * Its own module for two reasons: the config validator needs the DEFAULTS
 * to validate an override triple against the merged result, and importing
 * `patch-lint.ts` from `config-validate.ts` for a constant would draw an
 * import edge (and a cycle) between the rule bodies and config parsing.
 *
 * On the vocabulary: the bands were `notice` / `warning` / `error` with the
 * middle one described as a "soft limit". That description is false under
 * the posture FireForge itself recommends for a release gate,
 * `--max-warnings 0`, where a warning is a hard failure — so a file at 751
 * lines failed a gate with a message calling 750 soft. The message below
 * says what the band IS (a warning) and what a zero-warning gate does with
 * it, and the thresholds are now tunable, so a project whose file-size
 * policy differs has a dial instead of an argument.
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
 * The `warning` and `notice` bands name the gate consequence explicitly:
 * the number is advisory to patch-lint and blocking to a `--max-warnings 0`
 * gate, and an operator deciding whether to decompose a file needs to know
 * which of those they are looking at.
 */
export function formatFileTooLargeMessage(args: {
  label: string;
  lineCount: number;
  thresholds: ResolvedFileSizeTier;
  band: 'notice' | 'warning' | 'error';
  verb: string;
}): string {
  const { label, lineCount, thresholds, band, verb } = args;
  if (band === 'error') {
    return `${label} has ${String(lineCount)} lines (error threshold: ${String(thresholds.error)}). Consider ${verb}.`;
  }
  return (
    `${label} has ${String(lineCount)} lines (warning threshold: ${String(thresholds.warning)}, ` +
    `error threshold: ${String(thresholds.error)}). Consider ${verb}. ` +
    `Reported as a ${band}, which a gate running --max-warnings 0 treats as a failure; ` +
    `tune "patchLint.fileSizeThresholds" if these limits are wrong for this project.`
  );
}
