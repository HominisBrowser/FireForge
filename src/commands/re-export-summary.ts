// SPDX-License-Identifier: EUPL-1.2
/**
 * The one-line end-of-run summary of a multi-patch `re-export`.
 *
 * A long run interleaves per-patch lint output, drift previews and
 * refusals, and the patches it wrote were easy to confuse with the one it
 * did not. The summary names both sets and why each unwritten patch was
 * not written, so the re-run list is one line to read.
 */

/** What became of each selected patch. */
export interface ReExportRunTally {
  /** Selected patches, in run order. */
  selected: readonly string[];
  /** Patches written (or, in a dry run, that would be written). */
  written: readonly string[];
  /** Patches whose re-export threw. */
  failed: readonly string[];
  /** Patches refused by `--refuse-adjacent-unmanaged`. */
  refusedAdjacent: readonly string[];
  /** Patches refused by `--refuse-foreign-drift`. */
  refusedDrift: readonly string[];
  /** Whether the run is a dry run. */
  isDryRun: boolean;
}

/**
 * Renders the summary, or undefined for a single-patch run, where the
 * outcome line already says everything.
 */
export function formatReExportRunSummary(tally: ReExportRunTally): string | undefined {
  if (tally.selected.length <= 1) return undefined;
  const written = new Set(tally.written);
  const reasons = new Map<string, string>();
  for (const name of tally.failed) reasons.set(name, 'failed');
  for (const name of tally.refusedAdjacent) reasons.set(name, 'refused: adjacent unmanaged');
  for (const name of tally.refusedDrift) reasons.set(name, 'refused: foreign drift');
  const notWritten = tally.selected
    .filter((name) => !written.has(name))
    .map((name) => `${name} (${reasons.get(name) ?? 'skipped'})`);

  const verb = tally.isDryRun ? 'would write' : 'wrote';
  const writtenPart =
    tally.written.length > 0
      ? `${verb} ${tally.written.length} of ${tally.selected.length}: ${tally.written.join(', ')}`
      : `${verb} 0 of ${tally.selected.length}`;
  const notWrittenPart =
    notWritten.length > 0
      ? `; ${tally.isDryRun ? 'would NOT write' : 'NOT written'}: ${notWritten.join(', ')}`
      : '';
  return `Re-export summary: ${writtenPart}${notWrittenPart}.`;
}
