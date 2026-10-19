// SPDX-License-Identifier: EUPL-1.2
/**
 * `re-export --hunks-from <diff>` and `--exclude-hunks <diff>`: export a
 * file by hunk rather than as a whole.
 *
 * Re-export captures a file's working-tree content against engine HEAD, so
 * on a shared engine a peer's unexported line in the same manifest or chrome
 * document landed in the exporting patch, and the only way out was for the
 * peer to park its hunk by hand. These two modes build the file's new
 * content from the hunks a session names:
 *
 *  - `--hunks-from`: the patch's current body for the file (HEAD with the
 *    old section applied) plus only the named hunks. Files the diff does
 *    not name keep their old section.
 *  - `--exclude-hunks`: the working tree minus the named hunks. Files the
 *    diff does not name export as usual.
 *
 * Hunks are placed by their context, searched outward from the line their
 * header names, so a diff taken before a peer's edit above it still applies.
 * The synthetic content is diffed against HEAD by git itself, on a
 * throwaway index, so the section is byte-for-byte what a plain re-export
 * would write for that content.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { git } from '../core/git-base.js';
import { getFileContentAtRef, listTrackedInHead } from '../core/git-file-ops.js';
import { mintDisposableGitIndex } from '../core/git-readonly-index.js';
import {
  type DiffSection,
  type ParsedHunk,
  parseDiffGitHeader,
  parseDiffSections,
} from '../core/patch-parse.js';
import { applyPatchTextToContent } from '../core/patch-transform.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { PatchError } from '../errors/patch.js';
import { pathExists, readText } from '../utils/fs.js';
import { normalizeEngineRelativeInput } from './re-export-scan.js';

/** Which hunk mode a re-export runs in, and the diff naming the hunks. */
export interface HunkSelection {
  mode: 'include' | 'exclude';
  diffPath: string;
  flag: '--hunks-from' | '--exclude-hunks';
}

/** The selection a re-export's options ask for, if any. */
export function hunkSelectionOf(options: {
  hunksFrom?: string;
  excludeHunks?: string;
}): HunkSelection | undefined {
  if (options.hunksFrom !== undefined) {
    return { mode: 'include', diffPath: options.hunksFrom, flag: '--hunks-from' };
  }
  if (options.excludeHunks !== undefined) {
    return { mode: 'exclude', diffPath: options.excludeHunks, flag: '--exclude-hunks' };
  }
  return undefined;
}

/** Splits a diff into its raw per-file sections, keyed by target path. */
export function splitRawSections(diff: string): Map<string, string> {
  const sections = new Map<string, string>();
  let path: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (path !== undefined) sections.set(path, `${lines.join('\n')}\n`);
  };
  for (const line of diff.split('\n')) {
    const header = parseDiffGitHeader(line);
    if (header) {
      flush();
      path = header.targetPath;
      lines = [line];
    } else if (path !== undefined) {
      lines.push(line);
    }
  }
  flush();
  for (const [key, text] of sections) sections.set(key, text.replace(/\n+$/, '\n'));
  return sections;
}

/** The old and new line blocks a hunk replaces, swapped when reversed. */
function hunkBlocks(hunk: ParsedHunk, reverse: boolean): { from: string[]; to: string[] } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of hunk.lines) {
    const marker = line[0];
    const text = line.slice(1);
    if (marker === ' ' || marker === '-') oldLines.push(text);
    if (marker === ' ' || marker === '+') newLines.push(text);
  }
  return reverse ? { from: newLines, to: oldLines } : { from: oldLines, to: newLines };
}

function matchesAt(lines: readonly string[], block: readonly string[], at: number): boolean {
  if (at < 0 || at + block.length > lines.length) return false;
  return block.every((line, index) => lines[at + index] === line);
}

/** The match of `block` nearest `expected`, at or after `floor`. */
function findBlock(
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

/**
 * Applies `hunks` to `content` by context, forward or reversed. A hunk
 * whose context is not found refuses, naming it.
 */
export function applyHunksByContext(
  content: string,
  hunks: readonly ParsedHunk[],
  reverse: boolean,
  file: string
): string {
  const endsWithNewline = content.endsWith('\n') || content === '';
  const lines = content === '' ? [] : content.replace(/\n$/, '').split('\n');
  let offset = 0;
  let floor = 0;
  for (const hunk of hunks) {
    const { from, to } = hunkBlocks(hunk, reverse);
    const start = (reverse ? hunk.newStart : hunk.oldStart) - (from.length === 0 ? 0 : 1);
    const expected = Math.max(0, start + offset);
    const at = from.length === 0 ? expected : findBlock(lines, from, expected, floor);
    if (at === undefined) {
      throw new PatchError(
        `The hunk @@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ` +
          `does not ${reverse ? 'match the working tree' : 'apply to the patch body'} of ${file}: ` +
          `its ${reverse ? 'new' : 'old'}-side lines were not found.`
      );
    }
    lines.splice(at, from.length, ...to);
    offset += to.length - from.length + (at - expected);
    floor = at + to.length;
  }
  if (lines.length === 0) return '';
  return `${lines.join('\n')}${endsWithNewline ? '\n' : ''}`;
}

/**
 * Diffs `content` for `file` against engine HEAD the way a re-export would,
 * on a throwaway index so the shared one never moves.
 */
async function diffContentAgainstHead(
  engineDir: string,
  file: string,
  content: string,
  tracked: boolean
): Promise<string> {
  const index = await mintDisposableGitIndex(engineDir);
  if (index === undefined) {
    throw new GeneralError(
      `Cannot build a private git index in ${engineDir} to diff the hunk-selected ${file}.`
    );
  }
  const scratch = await mkdtemp(join(tmpdir(), 'fireforge-hunks-'));
  try {
    const temp = join(scratch, 'content');
    await writeFile(temp, content);
    const blob = (await git(['hash-object', '-w', '--path', file, '--', temp], engineDir)).trim();
    const mode = tracked
      ? ((await git(['ls-tree', 'HEAD', '--', file], engineDir)).split(/\s/)[0] ?? '100644')
      : '100644';
    await git(['update-index', '--add', '--cacheinfo', `${mode},${blob},${file}`], engineDir, {
      env: index.env,
    });
    return await git(['diff', '--binary', '--cached', 'HEAD', '--', file], engineDir, {
      env: index.env,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
    await index.dispose();
  }
}

/** Reads and checks the hunk diff: text sections for files the patch owns. */
async function readSelection(
  selection: HunkSelection,
  owned: readonly string[]
): Promise<Map<string, DiffSection>> {
  if (!(await pathExists(selection.diffPath))) {
    throw new InvalidArgumentError(
      `${selection.flag} ${selection.diffPath} does not exist.`,
      selection.flag
    );
  }
  const sections = parseDiffSections(await readText(selection.diffPath));
  if (sections.length === 0) {
    throw new InvalidArgumentError(
      `${selection.flag} ${selection.diffPath} holds no "diff --git" section.`,
      selection.flag
    );
  }
  const ownedSet = new Set(owned);
  const byFile = new Map<string, DiffSection>();
  for (const section of sections) {
    const file = normalizeEngineRelativeInput(section.targetPath, selection.flag);
    if (section.isBinary || section.sourcePath !== section.targetPath) {
      throw new InvalidArgumentError(
        `${selection.flag}: the section for ${file} is binary or a rename; only text hunks can be selected.`,
        selection.flag
      );
    }
    if (!ownedSet.has(file)) {
      throw new InvalidArgumentError(
        `${selection.flag}: ${file} is not a file this patch owns.`,
        selection.flag
      );
    }
    byFile.set(file, section);
  }
  return byFile;
}

/**
 * Builds the re-export body for a hunk-selected run: named files from the
 * selected hunks, the rest from the old body (`--hunks-from`) or the normal
 * working-tree diff (`--exclude-hunks`).
 *
 * @param args.normalDiff - The diff a plain re-export would write
 * @param args.oldBody - The patch's current body
 * @param args.files - The files the refreshed patch owns
 */
export async function buildHunkSelectedDiff(args: {
  engineDir: string;
  selection: HunkSelection;
  oldBody: string;
  normalDiff: string;
  files: readonly string[];
}): Promise<string> {
  const { engineDir, selection, oldBody, normalDiff, files } = args;
  const named = await readSelection(selection, files);
  const tracked = await listTrackedInHead(engineDir, [...named.keys()]);
  const fallback = splitRawSections(selection.mode === 'include' ? oldBody : normalDiff);
  const out: string[] = [];
  for (const file of [...files].sort()) {
    const section = named.get(file);
    if (section === undefined) {
      const raw = fallback.get(file);
      if (raw !== undefined) out.push(raw);
      continue;
    }
    const head = tracked.has(file) ? await getFileContentAtRef(engineDir, file) : null;
    let content: string;
    if (selection.mode === 'include') {
      const base = applyPatchTextToContent(head, oldBody, file);
      content = applyHunksByContext(base, section.hunks, false, file);
    } else {
      const worktree = join(engineDir, file);
      const current = (await pathExists(worktree)) ? await readText(worktree) : '';
      content = applyHunksByContext(current, section.hunks, true, file);
    }
    if (head !== null && content === head) continue;
    const diff = await diffContentAgainstHead(engineDir, file, content, tracked.has(file));
    if (diff.trim()) out.push(diff.endsWith('\n') ? diff : `${diff}\n`);
  }
  return out.join('');
}
