// SPDX-License-Identifier: EUPL-1.2
/**
 * Detects the new-file-plus-moved-code slice shape and names the working
 * sequence through it.
 *
 * A slice that adds new files and moves lines into them from an existing
 * patch has no path through the two refusal flags:
 *
 *  - `re-export --refuse-adjacent-unmanaged` refuses while the new files are
 *    still unmanaged, and
 *  - exporting the new files as their own patch fails cross-patch lint,
 *    because at the projected placement the old patch still contains the
 *    moved code.
 *
 * Each guard is individually correct. Together they dead-end, and the way out
 * is non-obvious: adopt the new files into the old patch first
 * (`re-export --scan --scan-file`), then split them out into a patch of their
 * own (`patch move-files --create --order N`).
 *
 * This module recognises the shape from evidence FireForge already has (the
 * pending diff's new-file content versus the added lines the existing patches
 * carry), so the refusal can name the sequence instead of leaving the
 * operator to derive it.
 */

import { extractAddedLinesPerFile } from './patch-lint-diff.js';

/** One run of consecutive lines a new file shares with an existing patch. */
export interface MovedCodeBlock {
  /** New-file path in the pending diff. */
  file: string;
  /** File in the source patch that carries the same run. */
  sourceFile: string;
  /** The matched substantive lines, trimmed, in order. */
  lines: string[];
}

/** One existing patch that already carries lines the new files would add. */
export interface MovedCodeOverlap {
  /** Filename of the patch that still contains the moved lines. */
  sourcePatch: string;
  /** New-file paths in the pending diff whose lines it overlaps. */
  files: string[];
  /** Count of substantive lines inside the matched blocks. */
  sharedLines: number;
  /** The matched blocks, so the claim can be checked line by line. */
  blocks: MovedCodeBlock[];
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

/**
 * Minimum run of consecutive substantive lines, in the same order in both
 * the new file and the source patch, before a block counts as moved code.
 * Matching scattered single lines instead let a large unrelated patch
 * "share" a dozen common statements with any new module and sent operators
 * down an adopt-then-split sequence through a patch that only carried a
 * `<script>` line for the file.
 */
const MOVED_CODE_BLOCK_THRESHOLD = 3;

function substantiveSequences(diff: string): Map<string, string[]> {
  const sequences = new Map<string, string[]>();
  for (const [file, lines] of extractAddedLinesPerFile(diff)) {
    const substantive = lines.map((line) => line.trim()).filter(isSubstantiveLine);
    if (substantive.length > 0) sequences.set(file, substantive);
  }
  return sequences;
}

/**
 * Longest-first, non-overlapping runs of `pending` that appear contiguously
 * in one of `sources`' files. Anchored on exact line matches, so the work
 * is bounded by the number of shared lines, not the product of the sizes.
 */
function findBlocks(
  file: string,
  pending: readonly string[],
  sources: ReadonlyMap<string, string[]>
): MovedCodeBlock[] {
  const positions = new Map<string, Array<[string, number]>>();
  for (const [sourceFile, lines] of sources) {
    lines.forEach((line, index) => {
      const list = positions.get(line) ?? [];
      list.push([sourceFile, index]);
      positions.set(line, list);
    });
  }

  const blocks: MovedCodeBlock[] = [];
  let i = 0;
  while (i < pending.length) {
    let best: { sourceFile: string; length: number } | undefined;
    for (const [sourceFile, start] of positions.get(pending[i] ?? '') ?? []) {
      const source = sources.get(sourceFile) ?? [];
      let length = 0;
      while (
        i + length < pending.length &&
        start + length < source.length &&
        pending[i + length] === source[start + length]
      ) {
        length += 1;
      }
      if (best === undefined || length > best.length) best = { sourceFile, length };
    }
    if (best !== undefined && best.length >= MOVED_CODE_BLOCK_THRESHOLD) {
      blocks.push({ file, sourceFile: best.sourceFile, lines: pending.slice(i, i + best.length) });
      i += best.length;
    } else {
      i += 1;
    }
  }
  return blocks;
}

/**
 * Finds existing patches that still carry a block of substantive lines the
 * pending diff's new files would add, the fingerprint of code moved out of
 * an existing patch into a new file.
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
  const pending = substantiveSequences(pendingDiff);
  if (pending.size === 0) return [];

  const overlaps: MovedCodeOverlap[] = [];
  for (const entry of entries) {
    const sources = substantiveSequences(entry.diff);
    if (sources.size === 0) continue;
    const blocks = [...pending].flatMap(([file, lines]) => findBlocks(file, lines, sources));
    if (blocks.length === 0) continue;
    overlaps.push({
      sourcePatch: entry.filename,
      files: [...new Set(blocks.map((block) => block.file))].sort(),
      sharedLines: blocks.reduce((sum, block) => sum + block.lines.length, 0),
      blocks,
    });
  }

  return overlaps.sort(
    (a, b) => b.sharedLines - a.sharedLines || a.sourcePatch.localeCompare(b.sourcePatch)
  );
}

/** Lines shown per matched block, and blocks shown per overlap. */
const SHOWN_BLOCK_LINES = 4;
const SHOWN_BLOCKS = 3;

/** Renders the matched blocks of one overlap, capped, as detail lines. */
function formatMatchedBlocks(overlap: MovedCodeOverlap): string[] {
  const lines: string[] = [];
  for (const block of overlap.blocks.slice(0, SHOWN_BLOCKS)) {
    lines.push(
      `  ${block.file} ← ${overlap.sourcePatch} (${block.sourceFile}), ${block.lines.length} line(s):`
    );
    for (const line of block.lines.slice(0, SHOWN_BLOCK_LINES)) lines.push(`    | ${line}`);
    if (block.lines.length > SHOWN_BLOCK_LINES) {
      lines.push(`    | … ${block.lines.length - SHOWN_BLOCK_LINES} more`);
    }
  }
  if (overlap.blocks.length > SHOWN_BLOCKS) {
    lines.push(`  … ${overlap.blocks.length - SHOWN_BLOCKS} more block(s)`);
  }
  return lines;
}

/** What the placement projection learned about the pending export. */
export interface MovedCodeAdviceInput {
  /** Result of {@link detectMovedCodeOverlaps}. */
  overlaps: readonly MovedCodeOverlap[];
  /** The filename the pending export would take. */
  newPatchName: string;
  /** The order the pending export would take. */
  insertionOrder: number;
  /**
   * New system modules in the pending diff that no patch registers
   * (`unregistered-system-module` findings on the new patch).
   */
  unregisteredModules?: readonly string[];
  /**
   * True when every error in the exported content is a missing
   * registration: registering is then the whole fix, and adopt-then-split
   * is not offered at all.
   */
  registrationResolvesAll?: boolean;
  /**
   * Why adopting the new files into the strongest overlap's source patch
   * would itself be refused (forward imports, size limit). Empty when the
   * adopt is clean.
   */
  adoptBlockers?: readonly string[];
}

/**
 * Renders the remedy lines appended to a placement refusal: "register
 * first" when new modules lack their moz.build registration, then the
 * adopt-then-split sequence for a real moved-code block, but only when the
 * adopt itself would pass. Each claim names its evidence (the matched
 * lines, the blocking findings) so it can be checked.
 *
 * @param input - See {@link MovedCodeAdviceInput}
 * @returns Detail lines, or an empty list when neither shape is present
 */
export function formatMovedCodeAdvice(input: MovedCodeAdviceInput): string[] {
  const lines: string[] = [];
  const unregistered = input.unregisteredModules ?? [];
  if (unregistered.length > 0) {
    lines.push(
      '',
      `Register first: ${unregistered.join(', ')} ${unregistered.length === 1 ? 'is a new system module' : 'are new system modules'} ` +
        'no patch registers in moz.build. Add the moz.build line in the patch that owns that ' +
        'moz.build; when its line is already in the working tree but unexported, declare it as a ' +
        'staged registration on that patch, re-run this export, then re-export that patch.' +
        (input.registrationResolvesAll === true
          ? ' The exported content has no other cross-patch error, so once registered the new ' +
            'files need no adoption into another patch.'
          : '')
    );
  }

  const strongest = input.overlaps[0];
  if (strongest === undefined || input.registrationResolvesAll === true) return lines;
  const blockers = input.adoptBlockers ?? [];
  const claim =
    `${strongest.sharedLines} substantive line(s) the new file(s) would add, in ` +
    `${strongest.blocks.length} matching block(s), are still carried by ${strongest.sourcePatch}:`;
  if (blockers.length > 0) {
    lines.push(
      '',
      claim,
      ...formatMatchedBlocks(strongest),
      `Adopting the new files into ${strongest.sourcePatch} first (adopt-then-split) would be refused too, so it is not offered:`,
      ...blockers.map((blocker) => `  - ${blocker}`)
    );
    return lines;
  }
  const adopt = formatAdoptThenSplitRemedy(strongest, input.newPatchName, input.insertionOrder);
  if (unregistered.length > 0) {
    adopt.splice(1, 0, 'Only if the export still fails once those modules are registered:');
  }
  lines.push(...adopt, `Matched lines: ${claim}`, ...formatMatchedBlocks(strongest));
  return lines;
}

/**
 * Renders the adopt-then-split remedy for the strongest overlap, as lines
 * appended to the refusal's detail list.
 *
 * @param strongest - The strongest overlap {@link detectMovedCodeOverlaps} found
 * @param newPatchName - The filename the pending export would take
 * @param insertionOrder - The order the pending export would take
 * @returns Detail lines
 */
function formatAdoptThenSplitRemedy(
  strongest: MovedCodeOverlap,
  newPatchName: string,
  insertionOrder: number
): string[] {
  const fileArgs = strongest.files.map((file) => `--scan-file ${file}`).join(' ');
  const moveArgs = strongest.files.map((file) => `--file ${file}`).join(' ');
  // `patch move-files --create` takes the new patch's name, not a
  // filename: strip the order prefix and the `.patch` suffix so the
  // suggested command is copy-pasteable.
  const suggestedName = newPatchName.replace(/^\d+-/, '').replace(/\.patch$/, '');
  return [
    '',
    `This looks like a new-file + moved-code slice: ${strongest.sharedLines} substantive ` +
      `line(s) the new file(s) would add are still carried by ${strongest.sourcePatch}. ` +
      'Exporting them as their own patch cannot pass cross-patch lint while the source patch ' +
      'still owns the same code, and re-exporting cannot adopt them while they are unmanaged — ' +
      'each guard is right, and together they dead-end.',
    'Working sequence (adopt, then split):',
    `  1. fireforge re-export ${strongest.sourcePatch} --scan ${fileArgs}`,
    `  2. fireforge patch move-files ${strongest.sourcePatch} ${suggestedName} --create --order ${insertionOrder} ${moveArgs}`,
    'Step 1 adopts the new files into the patch that already owns the moved lines; step 2 ' +
      'splits them back out as one transaction, so the queue is never in a state where two ' +
      'patches own the same code.',
  ];
}
