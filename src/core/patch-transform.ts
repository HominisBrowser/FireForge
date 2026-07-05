// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure content transformation functions for patch operations.
 * These operate on file content strings without filesystem side effects.
 */

import { PatchError } from '../errors/patch.js';
import { readText } from '../utils/fs.js';
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
 * Applies a patch's changes to content.
 * @param content - Original content (null for new files)
 * @param patchPath - Path to the patch file
 * @param targetFile - The file path within the patch
 * @returns Modified content
 */
export async function applyPatchToContent(
  content: string | null,
  patchPath: string,
  targetFile: string
): Promise<string> {
  const patchContent = await readText(patchPath);

  // Check if this is a new file patch for the target file specifically
  if (content === null) {
    if (isNewFileInPatch(patchContent, targetFile)) {
      return await extractNewFileContent(patchPath, targetFile);
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

    // Replace the old lines with new lines
    const startIndex = hunk.oldStart - 1;

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
