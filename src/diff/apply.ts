// SPDX-License-Identifier: EUPL-1.2
/**
 * The one in-memory patch applier: a file section's hunks applied to a
 * file's bytes, without git or the filesystem.
 *
 * Content is handled as a byte string (Latin-1, one character per byte) and
 * each hunk line is converted to the same form, so the result is exact
 * whatever the file's encoding and whatever the patch's.
 */
import { ExitCode, FireForgeError } from '../kernel/errors.js';
import type { FileDiff, Hunk } from './model.js';
import { hunkSides } from './query.js';

/** How {@link applyFileDiff} applies a section. */
export interface ApplyFileOptions {
  /** Undo the section instead: its new side is expected and replaced by its old. */
  reverse?: boolean;
}

interface Content {
  lines: string[];
  /** The last line ends with a newline (vacuously true for an empty file). */
  finalNewline: boolean;
}

interface Block {
  hunk: Hunk;
  from: string[];
  to: string[];
  fromNoNewline: boolean;
  toNoNewline: boolean;
  /** 0-based index the block is expected at. */
  start: number;
}

function conflict(file: FileDiff, message: string): FireForgeError {
  return new FireForgeError('diff-apply-conflict', `${file.path}: ${message}`, {
    exitCode: ExitCode.PATCH_ERROR,
    hint: 'The file is not in the state the patch was taken from. Regenerate the patch or resolve by hand.',
  });
}

function toByteString(file: FileDiff, line: string): string {
  // An ASCII line is the same in both encodings.
  return file.encoding === 'latin1' || Buffer.byteLength(line, 'utf8') === line.length
    ? line
    : Buffer.from(line, 'utf8').toString('latin1');
}

function blockOf(file: FileDiff, hunk: Hunk, reverse: boolean): Block {
  const sides = hunkSides(hunk);
  if (sides.old.length !== hunk.oldCount || sides.new.length !== hunk.newCount) {
    throw new FireForgeError(
      'diff-corrupt',
      `${file.path}: hunk "${hunk.header}" declares ${hunk.oldCount}/${hunk.newCount} lines but holds ${sides.old.length}/${sides.new.length}.`,
      { exitCode: ExitCode.PATCH_ERROR, hint: 'The patch was edited by hand; regenerate it.' }
    );
  }
  const old = sides.old.map((line) => toByteString(file, line));
  const next = sides.new.map((line) => toByteString(file, line));
  // A side of zero lines names the line before the change (`@@ -4,0 +5,2 @@`).
  const start = reverse
    ? hunk.newStart - (hunk.newCount === 0 ? 0 : 1)
    : hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1);
  const [from, to] = reverse ? [next, old] : [old, next];
  const [fromNoNewline, toNoNewline] = reverse
    ? [sides.newNoNewline, sides.oldNoNewline]
    : [sides.oldNoNewline, sides.newNoNewline];
  return { hunk, from, to, fromNoNewline, toNoNewline, start };
}

function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false;
  return block.every((line, index) => lines[at + index] === line);
}

/** Where `block` matches: at `expected` if it does there, else the nearest match at or after `floor`. */
function locate(
  lines: readonly string[],
  block: readonly string[],
  expected: number,
  floor: number
): number | undefined {
  for (let distance = 0; distance <= lines.length; distance++) {
    for (const at of distance === 0 ? [expected] : [expected - distance, expected + distance]) {
      if (at >= floor && matchesAt(lines, block, at)) return at;
    }
  }
  return undefined;
}

function applyBlock(
  file: FileDiff,
  content: Content,
  block: Block,
  place: { offset: number; floor: number }
): void {
  const { lines } = content;
  const expected = Math.min(lines.length, Math.max(place.floor, block.start + place.offset));
  const at = block.from.length === 0 ? expected : locate(lines, block.from, expected, place.floor);
  if (at === undefined) {
    throw conflict(file, `hunk "${block.hunk.header}" does not apply: its lines were not found.`);
  }
  const reachesEnd = at + block.from.length === lines.length;
  const newlineMismatch =
    block.from.length > 0
      ? (block.fromNoNewline && !reachesEnd) ||
        (reachesEnd && content.finalNewline === block.fromNoNewline)
      : reachesEnd && lines.length > 0 && !content.finalNewline;
  if (newlineMismatch) {
    throw conflict(
      file,
      `hunk "${block.hunk.header}" disagrees about the newline at the end of the file.`
    );
  }
  lines.splice(at, block.from.length, ...block.to);
  if (reachesEnd) content.finalNewline = !block.toNoNewline;
  place.offset += at - expected + block.to.length - block.from.length;
  place.floor = at + block.to.length;
}

function readContent(bytes: Uint8Array): Content {
  const text = Buffer.from(bytes).toString('latin1');
  if (text === '') return { lines: [], finalNewline: true };
  const lines = text.split('\n');
  const finalNewline = lines.at(-1) === '';
  if (finalNewline) lines.pop();
  return { lines, finalNewline };
}

/**
 * Applies a file section to a file's content. Each hunk is tried at the
 * line its header names, shifted by what earlier hunks moved; where its
 * lines are not there, at the nearest place they are. Hunk line counts and
 * end-of-file newlines are verified, and a hunk that cannot be placed fails
 * the whole section.
 *
 * For a new-file section, `applyFileDiff(file, undefined)` is the content the
 * section creates.
 *
 * @param file - The section
 * @param content - The file's bytes, or undefined when it does not exist
 * @param options - See {@link ApplyFileOptions}
 * @returns The new bytes, or undefined when the section deletes the file
 * @throws FireForgeError `diff-apply-conflict` when the content does not fit,
 *   `diff-corrupt` for a hunk whose counts disagree with its body, `diff-binary`
 *   for a binary section
 */
export function applyFileDiff(
  file: FileDiff,
  content: Uint8Array | undefined,
  options: ApplyFileOptions = {}
): Buffer | undefined {
  const reverse = options.reverse === true;
  if (file.binary !== undefined) {
    throw new FireForgeError(
      'diff-binary',
      `${file.path}: a binary section cannot be applied in memory.`,
      {
        exitCode: ExitCode.PATCH_ERROR,
      }
    );
  }
  const creates = file.status === (reverse ? 'deleted' : 'added');
  const removes = file.status === (reverse ? 'added' : 'deleted');
  if (content === undefined && !creates) throw conflict(file, 'the file does not exist.');
  if (content !== undefined && creates) throw conflict(file, 'the file already exists.');
  const state = content === undefined ? { lines: [], finalNewline: true } : readContent(content);
  const place = { offset: 0, floor: 0 };
  for (const hunk of file.hunks) applyBlock(file, state, blockOf(file, hunk, reverse), place);
  if (removes) {
    if (state.lines.length > 0) throw conflict(file, 'the file holds more than the patch removes.');
    return undefined;
  }
  const text =
    state.lines.length === 0 ? '' : state.lines.join('\n') + (state.finalNewline ? '\n' : '');
  return Buffer.from(text, 'latin1');
}
