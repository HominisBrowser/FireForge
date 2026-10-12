// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch-size lint: the `large-patch-lines` and `large-patch-files` rules,
 * the tier decision they share, and the measurement they read.
 *
 * Split out of `patch-lint.ts` (per-file line budget). `patch-lint.ts`
 * re-exports this module's surface so callers keep importing from there.
 */

import { join } from 'node:path';

import type { PatchLintIssue } from '../types/commands/index.js';
import type { FireForgeConfig, PatchLintPatchSizeMetric } from '../types/config.js';
import { pathExists, readText } from '../utils/fs.js';
import { codeLineMask } from './patch-lint-code-lines.js';
import { AGGREGATE_PATCH_FILE } from './patch-lint-diff-tag.js';
import {
  isPatchSizeRegistrationFile,
  type PatchSizeThresholds,
  type PatchSizeTierName,
  resolvePatchSizeThresholds,
} from './patch-lint-size-thresholds.js';
import { type DiffSection, parseDiffGitHeader, parseDiffSections } from './patch-parse.js';

/**
 * Shared remedy sentence for the over-budget findings. Every place an
 * operator stands when a patch outgrows its budget must name the
 * sanctioned one-transaction way out, or they reach for the wrong tools
 * first. One constant, so the wording cannot drift.
 */
const SPLIT_HINT =
  'Consider splitting into smaller, focused patches — ' +
  '"fireforge patch move-files <from> <to> --file <path> --create --order <n>" ' +
  'moves files into a new patch in one transaction.';

/**
 * Fixed allowlist of non-branding sibling paths that real-world Firefox
 * branding patches legitimately need to touch to register the new branding
 * flavor with the top-level configure. A predicate requiring every file to
 * live under `browser/branding/` drops a branding patch that also touches
 * `browser/moz.configure` (the canonical registration point) into the
 * general lint tier.
 *
 * Narrow on purpose: add entries only when a genuine branding patch
 * cannot be expressed without a specific registration sibling. Pinned
 * against ESR 140.x conventions at time of writing.
 */
const BRANDING_REGISTRATION_FILES: ReadonlySet<string> = new Set([
  'browser/moz.configure',
  'browser/confvars.sh',
]);

/**
 * Returns true when a patch qualifies for the branding threshold tier:
 * every file lives either under `browser/branding/` or in the narrow
 * registration allowlist, and the patch contains at least one file
 * under `browser/branding/` (guard against a config-only patch
 * accidentally qualifying as branding).
 */
function isBrandingOnlyPatch(files: ReadonlyArray<string>): boolean {
  if (files.length === 0) return false;
  let hasBrandingFile = false;
  for (const file of files) {
    if (file.startsWith('browser/branding/')) {
      hasBrandingFile = true;
      continue;
    }
    if (BRANDING_REGISTRATION_FILES.has(file)) continue;
    return false;
  }
  return hasBrandingFile;
}

/**
 * Returns true if the file path looks like a test file.
 * Matches paths containing `/test/` or filenames starting with
 * `browser_`, `test_`, or `xpcshell_` (all `.js`). This is the test class
 * of both size rules: `file-too-large` picks the test thresholds with it,
 * and the patch-size tier and the `addedCode` per-class split read it.
 */
export function isTestFile(file: string): boolean {
  if (file.includes('/test/')) return true;
  const basename = file.split('/').pop() ?? '';
  return /^(?:browser_|test_|xpcshell_).*\.js$/.test(basename);
}

/**
 * Counts the total lines in a unified diff and the number of non-binary
 * text lines, so binary hunks do not inflate patch size checks.
 *
 * Line counting agrees with `wc -l`: a trailing newline does not add a
 * phantom empty line to either `total` or the binary-hunk accounting.
 *
 * @param diffContent - Raw unified diff string
 * @returns Object with `total` line count and `textLines` (total minus binary hunk lines)
 */
export function countNonBinaryDiffLines(diffContent: string): {
  total: number;
  textLines: number;
} {
  return countDiffLines(diffContent, () => false);
}

/**
 * {@link countNonBinaryDiffLines} with whole file sections left out of
 * `textLines` when `isExcluded` names their path (registration files).
 */
function countDiffLines(
  diffContent: string,
  isExcluded: (path: string) => boolean
): { total: number; textLines: number } {
  const lines = diffContent.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  let uncounted = 0;
  let inBinaryHunk = false;
  let inExcluded = false;

  for (const line of lines) {
    if (line.startsWith('GIT binary patch')) {
      inBinaryHunk = true;
    } else if (line.startsWith('diff --git ')) {
      inBinaryHunk = false;
      const header = parseDiffGitHeader(line);
      inExcluded = header !== null && isExcluded(header.targetPath);
    }
    if (inBinaryHunk || inExcluded) {
      uncounted++;
    }
  }

  return { total, textLines: total - uncounted };
}

/**
 * Describes which tier `resolvePatchSizeTier` selected and why.
 * Consumers that want to surface the tier choice to the operator
 * (e.g. a one-line `info()` when branding thresholds kick in) read
 * this alongside the issues array from `lintPatchSize`.
 */
export type PatchSizeTierDecision =
  { tier: 'general' } | { tier: 'test' } | { tier: 'branding'; source: 'auto' | 'explicit' };

/**
 * Decides which patch-size threshold tier applies to a patch.
 * Exported so `runPatchLint` and the per-patch `lint` command can
 * surface the tier choice to the operator *without* depending on
 * `lintPatchSize`'s internal return shape.
 *
 * Precedence: test > branding (explicit) > branding (auto) > general.
 * The test tier beats branding because a table-driven regression test
 * is legitimately large independent of whether the patch also claims
 * branding shape, and the test-tier thresholds are already more
 * permissive than branding, so "tests beat branding" is the
 * defensive-for-tests choice.
 */
export function resolvePatchSizeTier(
  filesAffected: ReadonlyArray<string>,
  patchTier?: 'branding'
): PatchSizeTierDecision {
  const allTests = filesAffected.length > 0 && filesAffected.every(isTestFile);
  if (allTests) return { tier: 'test' };
  if (patchTier === 'branding') return { tier: 'branding', source: 'explicit' };
  if (isBrandingOnlyPatch(filesAffected)) return { tier: 'branding', source: 'auto' };
  return { tier: 'general' };
}

/**
 * The size thresholds a tier enforces, with `patchLint.patchSizeThresholds`
 * applied when `config` is passed. Public-API companion to
 * {@link resolvePatchSizeTier} / {@link countNonBinaryDiffLines} so
 * consumers can build waiver-freshness checks against the same numbers
 * `large-patch-lines` / `large-patch-files` fire on instead of mirroring
 * them. Without `config` it returns the built-in defaults.
 *
 * @param tier - The tier to read
 * @param config - The project configuration, whose overrides apply
 */
export function getPatchSizeThresholds(
  tier: PatchSizeTierName,
  config?: Pick<FireForgeConfig, 'patchLint'>
): PatchSizeThresholds {
  return resolvePatchSizeThresholds(tier, config?.patchLint?.patchSizeThresholds);
}

/** What a patch measures under the configured patch-size metric. */
export interface PatchSizeMeasurement {
  /** The metric `lines` is counted in. */
  metric: PatchLintPatchSizeMetric;
  /** Counted lines, registration files left out. */
  lines: number;
  /**
   * Of `lines`, those in test files. Only `addedCode` attributes lines per
   * file, so this is 0 under `diff`.
   */
  testLines: number;
  /** Files `large-patch-files` counts: the patch's files minus registration files. */
  files: number;
  /** Files left out of both counts as registration files. */
  registrationFiles: number;
}

/**
 * Measures a patch under `patchLint.patchSizeMetric`.
 *
 * `diff` counts the non-binary lines of the unified diff, headers and
 * context included. `addedCode` counts the added lines that carry code,
 * judged on each file's post-image read from `repoDir` (a hunk can start
 * inside a block comment, so the `+` lines alone cannot tell), and skips
 * lines inside Furnace fragment expansions. Files matching
 * `patchLint.patchSizeRegistrationFiles` count toward neither number.
 *
 * @param repoDir - Engine directory holding the post-images
 * @param diffContent - The patch's unified diff
 * @param filesAffected - The patch's files
 * @param config - Project configuration
 */
export async function measurePatchSize(
  repoDir: string,
  diffContent: string,
  filesAffected: readonly string[],
  config: Pick<FireForgeConfig, 'patchLint'>
): Promise<PatchSizeMeasurement> {
  const globs = config.patchLint?.patchSizeRegistrationFiles ?? [];
  const isRegistration = (file: string): boolean => isPatchSizeRegistrationFile(file, globs);
  const registrationFiles = filesAffected.filter(isRegistration).length;
  const files = filesAffected.length - registrationFiles;
  if (config.patchLint?.patchSizeMetric !== 'addedCode') {
    const lines = countDiffLines(diffContent, isRegistration).textLines;
    return { metric: 'diff', lines, testLines: 0, files, registrationFiles };
  }
  let lines = 0;
  let testLines = 0;
  for (const section of parseDiffSections(diffContent)) {
    if (section.isBinary || isRegistration(section.targetPath)) continue;
    const counted = await countAddedCodeLines(repoDir, section);
    lines += counted;
    if (isTestFile(section.targetPath)) testLines += counted;
  }
  return { metric: 'addedCode', lines, testLines, files, registrationFiles };
}

/**
 * Counts one section's added lines that carry code in the post-image.
 * Without a readable post-image, every non-blank added line counts: the
 * upper bound, so a missing file never shrinks the measurement.
 */
async function countAddedCodeLines(repoDir: string, section: DiffSection): Promise<number> {
  const path = join(repoDir, section.targetPath);
  const mask = (await pathExists(path))
    ? codeLineMask(section.targetPath, await readText(path)).code
    : undefined;
  let count = 0;
  for (const hunk of section.hunks) {
    let newLine = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.startsWith('\\') || line.startsWith('-')) continue;
      if (line.startsWith('+')) {
        const isCode = mask ? mask[newLine - 1] === true : line.slice(1).trim() !== '';
        if (isCode) count++;
      }
      newLine++;
    }
  }
  return count;
}

type SizeBand = 'notice' | 'warning' | 'error';

function bandFor(
  count: number,
  thresholds: { notice: number; warning: number; error: number | null }
): SizeBand | undefined {
  if (thresholds.error !== null && count > thresholds.error) return 'error';
  if (count > thresholds.warning) return 'warning';
  if (count > thresholds.notice) return 'notice';
  return undefined;
}

/**
 * Renders a patch-size finding. The notice band is advisory and says so;
 * the warning band names what a `--max-warnings 0` gate does with it and
 * where to tune it; the split hint rides on the bands that can fail a gate.
 */
function formatPatchSizeMessage(
  subject: string,
  band: SizeBand,
  thresholds: { notice: number; warning: number; error: number | null }
): string {
  const errorPart = thresholds.error === null ? '' : `, error threshold: ${thresholds.error}`;
  if (band === 'error') {
    return `${subject} (error threshold: ${thresholds.error}). ${SPLIT_HINT}`;
  }
  if (band === 'notice') {
    return (
      `${subject}, over the design target of ${thresholds.notice} ` +
      `(warning threshold: ${thresholds.warning}${errorPart}). ` +
      'Advisory; does not fail --max-warnings 0.'
    );
  }
  return (
    `${subject} (warning threshold: ${thresholds.warning}${errorPart}). ` +
    'Reported as a warning, which a gate running --max-warnings 0 treats as a failure; ' +
    'tune "patchLint.patchSizeThresholds" if these limits are wrong for this project. ' +
    SPLIT_HINT
  );
}

/** One line-count comparison: a count, the band triple it is held to, and its wording. */
interface LineCheck {
  count: number;
  thresholds: PatchSizeThresholds['lines'];
  scope: string;
}

/**
 * The line-count comparisons for a patch. Under `addedCode` a general-tier
 * patch splits per class: test files against the test tier's lines,
 * everything else against the general tier's, so a test riding with its
 * subject is held to the same budget as a test-only patch.
 */
function lineChecks(
  measurement: PatchSizeMeasurement,
  tier: PatchSizeTierName,
  thresholds: PatchSizeThresholds,
  config: Pick<FireForgeConfig, 'patchLint'> | undefined
): LineCheck[] {
  const perClass = measurement.metric === 'addedCode' && tier === 'general';
  if (!perClass || measurement.testLines === 0) {
    return [{ count: measurement.lines, thresholds: thresholds.lines, scope: '' }];
  }
  return [
    {
      count: measurement.lines - measurement.testLines,
      thresholds: thresholds.lines,
      scope: ' in non-test files',
    },
    {
      count: measurement.testLines,
      thresholds: getPatchSizeThresholds('test', config).lines,
      scope: ' in test files (test tier)',
    },
  ];
}

/**
 * Checks patch size against the tier's thresholds.
 *
 * @param filesAffected - Files touched by the patch
 * @param measured - The {@link measurePatchSize} result, or a bare
 *   non-binary diff line count (the `diff` metric over every file)
 * @param patchTier - Optional explicit tier override declared on
 *   `PatchMetadata.tier`. When `"branding"`, forces the branding
 *   thresholds regardless of `filesAffected`. Tests still win over
 *   branding (precedence `test > branding > general`).
 * @param config - Project configuration, for `patchLint.patchSizeThresholds`
 */
export function lintPatchSize(
  filesAffected: string[],
  measured: number | PatchSizeMeasurement,
  patchTier?: 'branding',
  config?: Pick<FireForgeConfig, 'patchLint'>
): PatchLintIssue[] {
  const measurement: PatchSizeMeasurement =
    typeof measured === 'number'
      ? {
          metric: 'diff',
          lines: measured,
          testLines: 0,
          files: filesAffected.length,
          registrationFiles: 0,
        }
      : measured;
  const issues: PatchLintIssue[] = [];

  // Both rules read off the same decision so the file-count and line-count
  // rules cannot disagree about which tier applies.
  const decision = resolvePatchSizeTier(filesAffected, patchTier);
  const thresholds = getPatchSizeThresholds(decision.tier, config);

  const filesBand = bandFor(measurement.files, thresholds.files);
  if (filesBand !== undefined) {
    const registration =
      measurement.registrationFiles > 0
        ? ` (not counting ${measurement.registrationFiles} registration file(s))`
        : '';
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-files',
      message: formatPatchSizeMessage(
        `Patch affects ${measurement.files} files${registration}`,
        filesBand,
        thresholds.files
      ),
      severity: filesBand,
      measurement: measurement.files,
    });
  }

  for (const check of lineChecks(measurement, decision.tier, thresholds, config)) {
    const band = bandFor(check.count, check.thresholds);
    if (band === undefined) continue;
    const subject =
      measurement.metric === 'addedCode'
        ? `Patch adds ${check.count} code lines${check.scope}`
        : `Patch is ${check.count} lines`;
    issues.push({
      file: AGGREGATE_PATCH_FILE,
      check: 'large-patch-lines',
      message: formatPatchSizeMessage(subject, band, check.thresholds),
      severity: band,
      measurement: check.count,
    });
  }

  return issues;
}
