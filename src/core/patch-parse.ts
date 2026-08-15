// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure parsing functions for extracting information from patch files.
 * All functions are synchronous and operate on string content.
 *
 * This module is the ONE unified-diff walker in the codebase. Before
 * {@link parseDiffSections} existed, six hand-rolled `diff --git` walkers
 * lived across patch-parse, patch-lint-diff, patch-registration-refs, and
 * patch-transform — with divergent CRLF handling (a CRLF-saved patch file
 * silently failed target-file matching and `\ No newline` detection on
 * Windows), no quoted-path support, and greedy path captures that
 * mis-split any path containing ` b/`. New diff-shaped parsing must build
 * on {@link parseDiffSections} rather than re-walking lines.
 */

/**
 * Extracts the order number from a patch filename.
 * Expects format like "001-description.patch"
 * @param filename - Patch filename
 * @returns Order number, or Infinity if no prefix
 */
export function extractOrder(filename: string): number {
  const match = /^(\d+)-/.exec(filename);
  if (match?.[1]) {
    return parseInt(match[1], 10);
  }
  return Infinity;
}

/**
 * A parsed `diff --git` header: both sides' paths, unquoted and with any
 * CRLF residue stripped.
 */
export interface DiffGitHeader {
  /** Old-side (`a/`) path. */
  sourcePath: string;
  /** New-side (`b/`) path — the file the patch produces. */
  targetPath: string;
}

/**
 * Un-escapes a path from git's C-style quoted form (`"a/pfad m\303\244..."`).
 * Handles the escapes git emits: `\\`, `\"`, `\t`, `\n`, `\r` and three-digit
 * octal byte escapes. Octal bytes are decoded through a byte buffer so
 * multibyte UTF-8 sequences (git's default `core.quotePath=true` encodes any
 * non-ASCII path this way) come back as the real characters.
 */
function unquoteGitPath(quoted: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < quoted.length; i++) {
    const ch = quoted[i];
    if (ch !== '\\') {
      // Plain character — may itself be multi-byte when the diff already
      // contains raw UTF-8; push its bytes.
      const encoded = Buffer.from(quoted[i] ?? '', 'utf-8');
      for (const b of encoded) bytes.push(b);
      continue;
    }
    const next = quoted[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      const octal = quoted.slice(i + 1, i + 4);
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    const mapped =
      next === 'n' ? 0x0a : next === 't' ? 0x09 : next === 'r' ? 0x0d : next.charCodeAt(0);
    bytes.push(mapped);
    i += 1;
  }
  return Buffer.from(bytes).toString('utf-8');
}

/**
 * Parses a `diff --git` line into its two paths.
 *
 * Handles the quoted form git emits for paths with special characters
 * (`diff --git "a/x y" "b/x y"`), and disambiguates the unquoted form for
 * paths that themselves contain ` b/`: for the overwhelmingly common
 * non-rename case the two paths are identical, so a symmetric split
 * (`a/<p> b/<p>`) is tried first — the previous greedy regex
 * (`a\/.+ b\/(.+)$`) split such lines at the LAST ` b/` and returned a
 * truncated path. Falls back to a non-greedy split for renames.
 *
 * @returns null when the line is not a diff --git header.
 */
export function parseDiffGitHeader(line: string): DiffGitHeader | null {
  const stripped = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!stripped.startsWith('diff --git ')) return null;
  const body = stripped.slice('diff --git '.length);

  // Quoted form (either or both sides may be quoted).
  const quoted = /^(?:"a\/((?:[^"\\]|\\.)*)"|a\/(\S+)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/.exec(
    body
  );
  if (quoted && (quoted[1] !== undefined || quoted[3] !== undefined)) {
    const sourcePath = quoted[1] !== undefined ? unquoteGitPath(quoted[1]) : (quoted[2] ?? '');
    const targetPath = quoted[3] !== undefined ? unquoteGitPath(quoted[3]) : (quoted[4] ?? '');
    return { sourcePath, targetPath };
  }

  if (!body.startsWith('a/')) return null;
  const rest = body.slice(2);

  // Symmetric split: body === `a/<p> b/<p>`. Correct even when <p>
  // contains ` b/`, which defeats any single-regex approach.
  if ((rest.length - 3) % 2 === 0) {
    const pathLength = (rest.length - 3) / 2;
    const candidate = rest.slice(0, pathLength);
    if (rest === `${candidate} b/${candidate}`) {
      return { sourcePath: candidate, targetPath: candidate };
    }
  }

  // Rename/copy (differing paths): non-greedy split at the first ` b/`.
  const asymmetric = /^(.+?) b\/(.+)$/.exec(rest);
  if (asymmetric?.[1] !== undefined && asymmetric[2] !== undefined) {
    return { sourcePath: asymmetric[1], targetPath: asymmetric[2] };
  }
  return null;
}

/**
 * One `diff --git` section of a unified diff, fully structured.
 */
export interface DiffSection {
  /** New-side (`b/`) path — the file this section produces. */
  targetPath: string;
  /** Old-side (`a/`) path. */
  sourcePath: string;
  /** True when the section carries a `new file mode` marker. */
  isNewFile: boolean;
  /** True when the section carries a `deleted file mode` marker. */
  isDeletedFile: boolean;
  /**
   * True for binary sections (`GIT binary patch` or `Binary files … differ`).
   * Binary sections have no parseable hunks; text-oriented consumers must
   * refuse them rather than treat base85 lines starting with `+` as content.
   */
  isBinary: boolean;
  /**
   * Old-side blob hash from the section's `index <old>..<new>` line
   * (possibly abbreviated). Undefined when the metadata zone carries no
   * parseable index line (hand-written diffs, `Binary files … differ`).
   */
  indexOldHash?: string;
  /** New-side blob hash from the `index` line; see {@link indexOldHash}. */
  indexNewHash?: string;
  /** Parsed hunks, in file order. Empty for binary or metadata-only sections. */
  hunks: ParsedHunk[];
}

/**
 * Splits raw diff content into lines, tolerating CRLF-saved patch files.
 *
 * The distinction matters: a patch file saved with CRLF endings (Windows
 * editor, `core.autocrlf` checkout) has `\r` on EVERY line including
 * structural ones — strip it, or headers, `@@` lines and the
 * `\ No newline at end of file` marker all fail to match. But an LF patch
 * of a file whose CONTENT is CRLF has `\r` only on payload lines, where it
 * is significant and must be preserved. Detect the former by checking the
 * structural lines themselves for a trailing `\r`.
 */
function splitDiffLines(diffContent: string): string[] {
  const lines = diffContent.split('\n');
  const isCrlfPatchFile = lines.some(
    (line) =>
      (line.startsWith('diff --git') || line.startsWith('@@ ')) &&
      line.endsWith('\r') &&
      line.length > 1
  );
  if (!isCrlfPatchFile) return lines;
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/**
 * Parses a unified diff into structured per-file sections — the single
 * shared walker every diff consumer builds on.
 */
export function parseDiffSections(diffContent: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const lines = splitDiffLines(diffContent);
  let current: DiffSection | null = null;
  let currentHunk: ParsedHunk | null = null;

  const finishHunk = (): void => {
    if (current && currentHunk) {
      current.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  for (const line of lines) {
    const header = parseDiffGitHeader(line);
    if (header) {
      finishHunk();
      current = {
        targetPath: header.targetPath,
        sourcePath: header.sourcePath,
        isNewFile: false,
        isDeletedFile: false,
        isBinary: false,
        hunks: [],
      };
      sections.push(current);
      continue;
    }

    if (!current) continue;

    if (currentHunk === null) {
      // File metadata zone (between the header and the first hunk).
      if (line.startsWith('new file mode')) {
        current.isNewFile = true;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        current.isDeletedFile = true;
        continue;
      }
      if (line === 'GIT binary patch' || /^Binary files .* differ$/.test(line)) {
        current.isBinary = true;
        continue;
      }
      // `git diff --binary` always records full blob hashes here (git
      // apply requires them); text sections carry abbreviated ones. The
      // hashes let binary sections be compared by identity when their
      // payload cannot be applied as text (FORGE J3).
      const indexMatch = /^index ([0-9a-f]{7,64})\.\.([0-9a-f]{7,64})(?: \d{6})?$/.exec(line);
      if (indexMatch?.[1] !== undefined && indexMatch[2] !== undefined) {
        current.indexOldHash = indexMatch[1];
        current.indexNewHash = indexMatch[2];
        continue;
      }
    }

    if (current.isBinary) continue;

    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      finishHunk();
      currentHunk = {
        oldStart: parseInt(hunkMatch[1] ?? '0', 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3] ?? '0', 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
        noNewlineAtEndOld: false,
        noNewlineAtEndNew: false,
      };
      continue;
    }

    if (!currentHunk) continue;

    if (line === '\\ No newline at end of file') {
      // The marker is an annotation on the immediately preceding body
      // line. Peek the last collected line to decide which side(s) the
      // annotation applies to — a single boolean cannot represent the
      // asymmetric case where only one side lacks the trailing newline.
      const previous = currentHunk.lines[currentHunk.lines.length - 1] ?? '';
      if (previous.startsWith('-')) {
        currentHunk.noNewlineAtEndOld = true;
      } else if (previous.startsWith('+')) {
        currentHunk.noNewlineAtEndNew = true;
      } else if (previous.startsWith(' ')) {
        // Context line: present in both sides, so the trailing-newline
        // absence applies to both. This is rare (it only happens when
        // the hunk ends on an unchanged line that itself is the last
        // line of the file) but real — git emits it.
        currentHunk.noNewlineAtEndOld = true;
        currentHunk.noNewlineAtEndNew = true;
      }
      // If the marker appears with no preceding body line (malformed
      // diff), leave both flags false — the downstream apply logic
      // will still produce a defined result.
      continue;
    }

    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      currentHunk.lines.push(line);
    }
  }

  finishHunk();
  return sections;
}

/**
 * Checks whether a specific file is a new-file addition within a patch.
 * For multi-file patches, only inspects the section belonging to targetFile.
 * @param patchContent - The full patch content
 * @param targetFile - The file path to check
 * @returns true if the patch creates targetFile as a new file
 */
export function isNewFileInPatch(patchContent: string, targetFile: string): boolean {
  return parseDiffSections(patchContent).some(
    (section) => section.targetPath === targetFile && section.isNewFile
  );
}

/**
 * Extracts affected file paths from a diff/patch content.
 * @param diffContent - The diff content to parse
 * @returns Array of file paths
 */
export function extractAffectedFiles(diffContent: string): string[] {
  const files = new Set<string>();
  for (const section of parseDiffSections(diffContent)) {
    files.add(section.targetPath);
  }

  if (files.size === 0) {
    // Header-less unified diff (no `diff --git` lines, e.g. hand-written
    // or `diff -u` output): fall back to the `+++ b/<path>` markers.
    for (const line of splitDiffLines(diffContent)) {
      const addMatch = /^\+\+\+ b\/(.+)$/.exec(line);
      if (addMatch?.[1] && addMatch[1] !== '/dev/null') {
        files.add(addMatch[1]);
      }
    }
  }

  return Array.from(files).sort();
}

/**
 * A single parsed hunk. `noNewlineAtEndOld` / `noNewlineAtEndNew` track the
 * `\ No newline at end of file` marker per side — the marker is a trailing
 * annotation on the immediately preceding body line, and a `-` precedent
 * sets only the old-side flag, a `+` sets only the new-side flag, and a
 * context ` ` line sets both. Collapsing the two into one boolean makes the
 * projection disagree with `git apply` on asymmetric trailing-newline
 * changes (e.g. removing a newline on one side but not the other).
 */
export interface ParsedHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  noNewlineAtEndOld: boolean;
  noNewlineAtEndNew: boolean;
}

/**
 * Parses hunks from a patch file for a specific target file.
 * @param patchContent - The full patch content
 * @param targetFile - The file path to extract hunks for
 * @returns Array of hunk objects with line info and changes
 */
export function parseHunksForFile(patchContent: string, targetFile: string): ParsedHunk[] {
  return parseDiffSections(patchContent)
    .filter((section) => section.targetPath === targetFile)
    .flatMap((section) => section.hunks);
}

/**
 * Extracts conflicting file paths from git apply error message.
 */
export function extractConflictingFiles(error?: string): string[] {
  if (!error) return [];

  const files: string[] = [];
  const lines = error.split('\n');

  for (const line of lines) {
    // Match "error: patch failed: path/to/file:line"
    const match = /error: patch failed: ([^:]+)/.exec(line);
    if (match?.[1]) {
      files.push(match[1]);
    }
  }

  return files;
}
