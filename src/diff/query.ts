// SPDX-License-Identifier: EUPL-1.2
/** Questions asked of a parsed patch. */
import type { FileDiff, Hunk, Patch } from './model.js';

/** The two sides of a hunk, without markers. */
export interface HunkSides {
  readonly old: readonly string[];
  readonly new: readonly string[];
  /** The old side ends the file without a final newline. */
  readonly oldNoNewline: boolean;
  /** The new side ends the file without a final newline. */
  readonly newNoNewline: boolean;
}

/**
 * Splits a hunk into its old and new lines. A `\ No newline at end of file`
 * marker applies to the side of the line before it: a removed line's marks
 * the old side, an added line's the new side, a context line's both.
 *
 * @param hunk - The hunk
 */
export function hunkSides(hunk: Hunk): HunkSides {
  const old: string[] = [];
  const next: string[] = [];
  let oldNoNewline = false;
  let newNoNewline = false;
  let previous = '';
  for (const line of hunk.lines) {
    const marker = line.charAt(0);
    if (marker === '\\') {
      if (previous !== '+') oldNoNewline = true;
      if (previous !== '-') newNoNewline = true;
      continue;
    }
    const text = line.slice(1);
    if (marker !== '+') old.push(text);
    if (marker !== '-') next.push(text);
    previous = marker === '-' || marker === '+' ? marker : ' ';
  }
  return { old, new: next, oldNoNewline, newNoNewline };
}

/**
 * Every path a patch touches, sorted and unique: both sides of a rename, the
 * new side of a copy, the path of anything else.
 *
 * @param patch - The patch
 */
export function affectedPaths(patch: Patch): string[] {
  const paths = new Set<string>();
  for (const file of patch.files) {
    paths.add(file.path);
    if (file.status === 'renamed') paths.add(file.oldPath);
  }
  return [...paths].sort();
}

/**
 * The lines a section adds, with their line numbers in the new file.
 *
 * @param file - The section
 */
export function addedLines(file: FileDiff): Array<{ line: number; text: string }> {
  const added: Array<{ line: number; text: string }> = [];
  for (const hunk of file.hunks) {
    let line = hunk.newStart;
    for (const body of hunk.lines) {
      const marker = body.charAt(0);
      if (marker === '+') added.push({ line, text: body.slice(1) });
      if (marker === '+' || marker === ' ' || body === '') line++;
    }
  }
  return added;
}
