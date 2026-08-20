// SPDX-License-Identifier: EUPL-1.2
/**
 * Detects the new-file-plus-moved-code slice shape and names the working
 * sequence through it.
 *
 * A slice that ADDS new files and MOVES lines into them from an existing
 * patch has no path through the two refusal flags:
 *
 *  - `re-export --refuse-adjacent-unmanaged` refuses while the new files
 *    are still unmanaged; and
 *  - exporting the new files as their own patch fails cross-patch lint,
 *    because at the projected placement the OLD patch still contains the
 *    moved code.
 *
 * Each guard is individually correct. Together they dead-end, and the way
 * out is non-obvious: adopt the new files into the OLD patch first
 * (`re-export --scan --scan-file`), then split them out into a patch of
 * their own (`patch move-files --create --order N`).
 *
 * This module recognises the shape from evidence FireForge already has —
 * the pending diff's new-file content versus the added lines the existing
 * patches carry — so the refusal can name the sequence instead of leaving
 * the operator to derive it.
 */

import { extractAddedLinesPerFile } from './patch-lint-diff.js';

/** One existing patch that already carries lines the new files would add. */
export interface MovedCodeOverlap {
  /** Filename of the patch that still contains the moved lines. */
  sourcePatch: string;
  /** New-file paths in the pending diff whose lines it overlaps. */
  files: string[];
  /** Count of distinct non-trivial lines shared. */
  sharedLines: number;
}

/** Minimal queue view this detector needs. */
export interface MovedCodeQueueEntry {
  filename: string;
  diff: string;
}

/**
 * Lines too generic to be evidence of a move: closing braces, blank
 * lines, bare keywords, import punctuation. Requiring substance keeps the
 * detector from firing on every patch that happens to contain a `}`.
 */
function isSubstantiveLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 12) return false;
  if (/^[)\]};,]+$/.test(trimmed)) return false;
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
  return true;
}

/** Minimum shared substantive lines before the shape is claimed. */
const MOVED_CODE_LINE_THRESHOLD = 3;

/**
 * Finds existing patches that still carry substantive lines the pending
 * diff's NEW files would add — the fingerprint of code moved out of an
 * existing patch into a new file.
 *
 * Pure. Overlaps are returned strongest-first so the message names the
 * most likely source patch.
 *
 * @param pendingDiff - The diff the export would write
 * @param entries - The existing queue's patches
 * @returns Overlaps, or an empty list when the shape is not present
 */
export function detectMovedCodeOverlaps(
  pendingDiff: string,
  entries: readonly MovedCodeQueueEntry[]
): MovedCodeOverlap[] {
  const pendingByFile = extractAddedLinesPerFile(pendingDiff);
  const pendingLines = new Map<string, Set<string>>();
  for (const [file, lines] of pendingByFile) {
    const substantive = new Set(lines.map((line) => line.trim()).filter(isSubstantiveLine));
    if (substantive.size > 0) pendingLines.set(file, substantive);
  }
  if (pendingLines.size === 0) return [];

  const overlaps: MovedCodeOverlap[] = [];
  for (const entry of entries) {
    const existing = new Set<string>();
    for (const lines of extractAddedLinesPerFile(entry.diff).values()) {
      for (const line of lines) {
        const trimmed = line.trim();
        if (isSubstantiveLine(trimmed)) existing.add(trimmed);
      }
    }
    if (existing.size === 0) continue;

    const files: string[] = [];
    const shared = new Set<string>();
    for (const [file, lines] of pendingLines) {
      let fileShared = 0;
      for (const line of lines) {
        if (!existing.has(line)) continue;
        shared.add(line);
        fileShared += 1;
      }
      if (fileShared > 0) files.push(file);
    }
    if (shared.size >= MOVED_CODE_LINE_THRESHOLD && files.length > 0) {
      overlaps.push({ sourcePatch: entry.filename, files: files.sort(), sharedLines: shared.size });
    }
  }

  return overlaps.sort(
    (a, b) => b.sharedLines - a.sharedLines || a.sourcePatch.localeCompare(b.sourcePatch)
  );
}

/**
 * Renders the adopt-then-split remedy for the strongest overlap, as lines
 * appended to the refusal's detail list.
 *
 * @param overlaps - Result of {@link detectMovedCodeOverlaps}
 * @param newPatchName - The filename the pending export would take
 * @param insertionOrder - The order the pending export would take
 * @returns Detail lines, or an empty list when the shape is not present
 */
export function formatAdoptThenSplitRemedy(
  overlaps: readonly MovedCodeOverlap[],
  newPatchName: string,
  insertionOrder: number
): string[] {
  const strongest = overlaps[0];
  if (strongest === undefined) return [];
  const fileArgs = strongest.files.map((file) => `--scan-file ${file}`).join(' ');
  const moveArgs = strongest.files.map((file) => `--file ${file}`).join(' ');
  // `patch move-files --create` takes the new patch's NAME, not a
  // filename: strip the order prefix and the `.patch` suffix so the
  // suggested command is copy-pasteable.
  const suggestedName = newPatchName.replace(/^\d+-/, '').replace(/\.patch$/, '');
  return [
    '',
    `This looks like a new-file + moved-code slice: ${String(strongest.sharedLines)} substantive ` +
      `line(s) the new file(s) would add are still carried by ${strongest.sourcePatch}. ` +
      'Exporting them as their own patch cannot pass cross-patch lint while the source patch ' +
      'still owns the same code, and re-exporting cannot adopt them while they are unmanaged — ' +
      'each guard is right, and together they dead-end.',
    'Working sequence (adopt, then split):',
    `  1. fireforge re-export ${strongest.sourcePatch} --scan ${fileArgs}`,
    `  2. fireforge patch move-files ${strongest.sourcePatch} ${suggestedName} --create --order ${String(insertionOrder)} ${moveArgs}`,
    'Step 1 adopts the new files into the patch that already owns the moved lines; step 2 ' +
      'splits them back out as one transaction, so the queue is never in a state where two ' +
      'patches own the same code.',
  ];
}
