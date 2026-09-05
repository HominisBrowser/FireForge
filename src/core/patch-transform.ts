// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure content transformation functions for patch operations.
 * These operate on file content strings without filesystem side effects.
 */

import { PatchError } from '../errors/patch.js';
import { readText } from '../utils/fs.js';
import type { DiffSection } from './patch-parse.js';
import { isNewFileInPatch, parseDiffSections, parseHunksForFile } from './patch-parse.js';

/**
 * Extracts the complete file content from a "new file" patch given a raw
 * diff string already in memory. Callers with a patch file path should
 * prefer {@link extractNewFileContent}; this helper exists for code paths
 * that already hold the diff (e.g. the in-flight export planner) and do
 * not want to round-trip through the filesystem.
 *
 * @param diff - Raw unified-diff content
 * @param targetFile - Optional target file to scope extraction to
 * @returns The file content that the patch would create
 * @throws PatchError for binary sections — a `GIT binary patch` payload is
 *   base85 (whose alphabet includes `+`), so "extract the + lines" would
 *   silently write garbage text over a binary target. Callers must treat
 *   binary new-file conflicts as unresolvable rather than auto-resolving.
 */
export function extractNewFileContentFromDiff(diff: string, targetFile?: string): string {
  const sections = parseDiffSections(diff).filter(
    (section) => !targetFile || section.targetPath === targetFile
  );

  const binary = sections.find((section) => section.isBinary);
  if (binary) {
    throw new PatchError(
      `Cannot extract text content from binary patch section for ${binary.targetPath}`,
      binary.targetPath
    );
  }

  return contentFromSections(sections);
}

/**
 * Walks the added (`+`) lines of already-parsed sections into file content.
 * Shared by {@link extractNewFileContentFromDiff} and
 * {@link buildNewFileTextProjection} so the two cannot drift on the empty-file
 * and no-trailing-newline cases below.
 */
function contentFromSections(sections: readonly DiffSection[]): string {
  // An empty new file is a legitimate git diff: `new file mode` with no
  // hunks at all. It must extract as '' — the historical line-walker
  // returned '\n' for it, creating a one-byte file that failed checksum
  // and drift comparisons against the truly empty file the patch creates.
  const hunks = sections.flatMap((section) => section.hunks);
  if (hunks.length === 0) {
    return '';
  }

  const contentLines: string[] = [];
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      // Lines starting with + are added content (skip the + prefix).
      // `-`/context lines shouldn't exist in new-file patches.
      if (line.startsWith('+')) {
        contentLines.push(line.slice(1));
      }
    }
  }

  const lastHunk = hunks[hunks.length - 1];
  const hasNoNewlineMarker = lastHunk?.noNewlineAtEndNew ?? false;

  // Join lines and handle trailing newline
  const result = contentLines.join('\n');
  return hasNoNewlineMarker ? result : result + '\n';
}

/**
 * Projects every TEXT new file a diff creates into a path → content map, for
 * the cross-patch lint projections that build a synthetic patch-queue entry.
 *
 * Binary new files are SKIPPED rather than refused. The map feeds only the
 * forward-import rule, which scans content for import statements — a binary
 * blob authors none, so omitting it contributes exactly what including it
 * would. Refusing instead (which is what
 * {@link extractNewFileContentFromDiff} correctly does for a caller that
 * named ONE file) made vendoring a new binary impossible: every projection
 * site fed it every detected new file, so `export --order`, `re-export
 * --scan --scan-file`, `patch move-files-into` and `patch split` all died on
 * a file the export half had just written a valid `GIT binary patch` for.
 * Nothing is lost by skipping: binary bodies are covered independently by the
 * `binary-body-not-reconstructable` queue lint, and
 * `buildPatchQueueContext` already tolerates them for real queue entries.
 *
 * One parse for the whole diff, rather than one per new file as the five
 * call sites previously did.
 */
export function buildNewFileTextProjection(diff: string): Map<string, string> {
  const newFiles = new Map<string, string>();
  for (const section of parseDiffSections(diff)) {
    if (!section.isNewFile || section.isBinary) continue;
    newFiles.set(section.targetPath, contentFromSections([section]));
  }
  return newFiles;
}

/**
 * Extracts the complete file content from a "new file" patch.
 * When targetFile is provided, only extracts content for that file
 * (required for multi-file patches).
 * @param patchPath - Path to the patch file
 * @param targetFile - Optional target file to scope extraction to
 * @returns The file content that the patch would create
 */
export async function extractNewFileContent(
  patchPath: string,
  targetFile?: string
): Promise<string> {
  const content = await readText(patchPath);
  return extractNewFileContentFromDiff(content, targetFile);
}

/**
 * Applies an already-read patch body to content. Batched callers that hold
 * many (patch, file) pairs use this to read each patch body once instead of
 * once per pair.
 * @param content - Original content (null for new files)
 * @param patchContent - Full text of the patch body
 * @param targetFile - The file path within the patch
 * @returns Modified content
 */
export function applyPatchTextToContent(
  content: string | null,
  patchContent: string,
  targetFile: string
): string {
  // Check if this is a new file patch for the target file specifically
  if (content === null) {
    if (isNewFileInPatch(patchContent, targetFile)) {
      return extractNewFileContentFromDiff(patchContent, targetFile);
    }
    // If not a new file patch but content is null, return empty
    return '';
  }

  const hunks = parseHunksForFile(patchContent, targetFile);
  if (hunks.length === 0) {
    return content;
  }

  // Apply hunks
  const contentLines = content.split('\n');
  // Remove trailing empty line if content ends with newline (but not for empty files)
  if (contentLines.length > 1 && contentLines[contentLines.length - 1] === '') {
    contentLines.pop();
  }

  // Process hunks in reverse order to preserve line numbers
  const sortedHunks = [...hunks].sort((a, b) => b.oldStart - a.oldStart);

  // The "no newline at end" marker applies to the last hunk in file order
  // (highest oldStart), which is the *first* hunk in our reverse-sorted array.
  // We read the new-side flag because the output we produce corresponds to
  // the new side; asymmetric diffs (old lacks newline, new has one — or
  // vice versa) would otherwise disagree with `git apply`.
  const lastHunkNoNewline = sortedHunks[0]?.noNewlineAtEndNew ?? false;
  for (const hunk of sortedHunks) {
    const newLines: string[] = [];

    // Compute actual old-line count from hunk body for cross-check
    let actualOldCount = 0;
    for (const line of hunk.lines) {
      if (line.startsWith('+')) {
        newLines.push(line.slice(1));
      } else if (line.startsWith(' ')) {
        newLines.push(line.slice(1));
        actualOldCount++;
      } else if (line.startsWith('-')) {
        actualOldCount++;
      }
      // Lines starting with '-' are removed (not added to newLines)
    }

    if (actualOldCount !== hunk.oldCount) {
      throw new PatchError(
        `Patch hunk header mismatch for ${targetFile}: header says ${hunk.oldCount} old lines but body has ${actualOldCount}`,
        targetFile
      );
    }

    // Replace the old lines with new lines. Unified-diff convention: for a
    // pure-insertion hunk (`@@ -N,0 +M,k @@`), N names the line BEFORE the
    // insertion point, so content is spliced at index N (after line N) —
    // `N - 1` inserted one line too early, and `@@ -0,0` (insert at top of
    // file) produced splice(-1, …), which inserts before the LAST element.
    const startIndex = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;

    // Verify context lines match before applying
    let verifyIndex = startIndex;
    for (const hunkLine of hunk.lines) {
      if (hunkLine.startsWith(' ') || hunkLine.startsWith('-')) {
        const expectedContent = hunkLine.slice(1);
        const actualContent = contentLines[verifyIndex];
        if (actualContent !== expectedContent) {
          throw new PatchError(
            `Patch context mismatch at line ${verifyIndex + 1} for ${targetFile}: ` +
              `expected "${expectedContent}", got "${actualContent}"`,
            targetFile
          );
        }
        verifyIndex++;
      }
    }

    contentLines.splice(startIndex, hunk.oldCount, ...newLines);
  }

  // Respect the no-newline-at-end-of-file marker from the last hunk
  if (lastHunkNoNewline) {
    return contentLines.join('\n');
  }
  return contentLines.join('\n') + '\n';
}
