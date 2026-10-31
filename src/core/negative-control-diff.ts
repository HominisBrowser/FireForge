// SPDX-License-Identifier: EUPL-1.2
/**
 * Parsing and strict application of a `fireforge test --negative-control`
 * diff.
 *
 * A control is a reviewed mutation, so the applier is deliberately strict:
 * every context and removed line must match exactly, the only tolerance is
 * a line offset (the same one `git apply` allows, never fuzz), and a hunk
 * that does not apply refuses the whole control before any file is
 * written. Only plain text modifications of existing files are accepted: a
 * created, deleted, renamed or binary file has no byte-exact restore story
 * that is worth its risk for a neuter.
 */

import { GeneralError } from '../errors/base.js';
import { isContainedRelativePath, normalizePathSlashes } from '../utils/paths.js';
import { type ParsedHunk, parseDiffSections, withGitHeaders } from './patch-parse.js';

/** One file of a control diff. */
export interface ControlDiffFile {
  /** The path the diff names, without git's `a/`/`b/` prefix. */
  path: string;
  /** The hunks to apply, in file order. */
  hunks: ParsedHunk[];
}

function refuse(message: string): never {
  throw new GeneralError(`Negative control diff refused: ${message}`);
}

/** Options for {@link parseControlDiff}. */
export interface ParseControlDiffOptions {
  /**
   * Called for a section whose old and new paths differ. Returns the path
   * the control targets (a `git diff --no-index <file> <edited copy>` names
   * the copy on its new side), or undefined for a real rename, which is
   * refused.
   */
  resolveRename?: (sourcePath: string, targetPath: string) => string | undefined;
}

/**
 * Parses a control diff. Accepts `git diff` output (a `diff --git` header
 * per file), which is what `git -C engine diff -- <file>` or a project-root
 * `git diff` writes, a plain unified diff (`diff -u`), and, through
 * `resolveRename`, a `git diff --no-index` against an edited copy.
 *
 * @param content - The diff file's text
 * @param options - See {@link ParseControlDiffOptions}
 * @returns One entry per file, in diff order
 */
export function parseControlDiff(
  content: string,
  options: ParseControlDiffOptions = {}
): ControlDiffFile[] {
  const sections = parseDiffSections(withGitHeaders(content));
  if (sections.length === 0) {
    refuse(
      'no diff sections found. Write the control with git, e.g. ' +
        '`git -C engine diff -- <file> > control.diff` after making the edit, then revert the edit.'
    );
  }
  const files = new Map<string, ControlDiffFile & { sections: number }>();
  for (const section of sections) {
    let path = normalizePathSlashes(section.targetPath);
    if (section.isBinary) refuse(`${path} is a binary section.`);
    if (section.isNewFile || section.isDeletedFile) {
      refuse(`${path} creates or deletes a file; a control may only modify existing text files.`);
    }
    if (section.sourcePath !== section.targetPath) {
      const resolved = options.resolveRename?.(section.sourcePath, section.targetPath);
      if (resolved === undefined) {
        refuse(`${section.sourcePath} -> ${path} is a rename; a control may only modify files.`);
      }
      path = normalizePathSlashes(resolved);
    }
    if (!isContainedRelativePath(path)) {
      refuse(`${path} is not a contained relative path.`);
    }
    if (section.hunks.length === 0) refuse(`${path} has no hunks.`);
    const existing = files.get(path);
    if (existing === undefined) {
      files.set(path, { path, hunks: [...section.hunks], sections: 1 });
    } else {
      existing.hunks.push(...section.hunks);
      existing.sections += 1;
    }
  }
  return [...files.values()].map(({ path, hunks, sections: count }) => ({
    path,
    hunks: count === 1 ? hunks : mergeSectionHunks(path, hunks),
  }));
}

/**
 * Orders the hunks of a file that several sections name (a generator that
 * writes one section per edit) as one section's would be. Hunks that
 * overlap cannot be applied one after another, so they are refused.
 */
function mergeSectionHunks(path: string, hunks: readonly ParsedHunk[]): ParsedHunk[] {
  const ordered = [...hunks].sort((left, right) => left.oldStart - right.oldStart);
  ordered.forEach((hunk, index) => {
    const previous = ordered[index - 1];
    if (previous !== undefined && previous.oldStart + previous.oldCount > hunk.oldStart) {
      refuse(
        `${path} appears in more than one section, and hunks from them overlap ` +
          `(@@ -${previous.oldStart},${previous.oldCount} @@ and @@ -${hunk.oldStart},${hunk.oldCount} @@). ` +
          'Make every edit to the file, then write one section for it with `git -C engine diff -- <file>`.'
      );
    }
  });
  return ordered;
}

interface HunkSides {
  oldLines: string[];
  newLines: string[];
}

function hunkSides(hunk: ParsedHunk, label: string, index: number): HunkSides {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk.lines) {
    const body = line.slice(1);
    if (line.startsWith(' ') || line.startsWith('-')) oldLines.push(body);
    if (line.startsWith(' ') || line.startsWith('+')) newLines.push(body);
  }
  if (oldLines.length !== hunk.oldCount || newLines.length !== hunk.newCount) {
    refuse(
      `hunk ${index + 1} of ${label} is malformed: its header counts ` +
        `(-${hunk.oldCount} +${hunk.newCount}) do not match its body ` +
        `(-${oldLines.length} +${newLines.length}).`
    );
  }
  return { oldLines, newLines };
}

function matchesAt(lines: readonly string[], block: readonly string[], position: number): boolean {
  if (position < 0 || position + block.length > lines.length) return false;
  return block.every((line, offset) => lines[position + offset] === line);
}

/**
 * The position nearest `anchor`, at or after `floor`, where `block`
 * matches, or -1.
 */
function findBlock(
  lines: readonly string[],
  block: readonly string[],
  anchor: number,
  floor: number
): number {
  const start = Math.max(anchor, floor);
  for (let delta = 0; delta <= lines.length; delta += 1) {
    if (matchesAt(lines, block, start + delta)) return start + delta;
    const below = anchor - delta;
    if (delta > 0 && below >= floor && matchesAt(lines, block, below)) return below;
  }
  return -1;
}

/**
 * Applies `hunks` to `original`, strictly.
 *
 * @param original - The file's current text
 * @param hunks - Hunks parsed from the control diff
 * @param label - File label for refusal messages
 * @returns The mutated text
 * @throws GeneralError when any hunk does not apply
 */
export function applyControlHunks(
  original: string,
  hunks: readonly ParsedHunk[],
  label: string
): string {
  const hasFinalNewline = original.endsWith('\n');
  const lines =
    original === '' ? [] : (hasFinalNewline ? original.slice(0, -1) : original).split('\n');
  const result: string[] = [];
  let cursor = 0;
  let finalNewline = hasFinalNewline;
  hunks.forEach((hunk, index) => {
    const { oldLines, newLines } = hunkSides(hunk, label, index);
    const anchor = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    const position =
      oldLines.length === 0
        ? anchor >= cursor && anchor <= lines.length
          ? anchor
          : -1
        : findBlock(lines, oldLines, anchor, cursor);
    const reachesEnd = position + oldLines.length === lines.length;
    const endMatches =
      position >= 0 &&
      (reachesEnd && oldLines.length > 0
        ? hunk.noNewlineAtEndOld === !hasFinalNewline
        : !hunk.noNewlineAtEndOld);
    if (position < 0 || !endMatches) {
      const alreadyApplied =
        newLines.length > 0 && findBlock(lines, newLines, Math.max(0, hunk.newStart - 1), 0) >= 0;
      refuse(
        `hunk ${index + 1} of ${label} (@@ -${hunk.oldStart},${hunk.oldCount} ` +
          `+${hunk.newStart},${hunk.newCount} @@) does not apply to the current file.` +
          (alreadyApplied
            ? ' Its new side is already present: the mutation looks applied already (an earlier control that was not restored?).'
            : ' The file changed since the diff was written; regenerate the control against it.')
      );
    }
    result.push(...lines.slice(cursor, position), ...newLines);
    cursor = position + oldLines.length;
    if (reachesEnd) finalNewline = !hunk.noNewlineAtEndNew;
  });
  result.push(...lines.slice(cursor));
  return result.join('\n') + (finalNewline && result.length > 0 ? '\n' : '');
}
