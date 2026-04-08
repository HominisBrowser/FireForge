// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure content transformation functions for patch operations.
 * These operate on file content strings without filesystem side effects.
 */

import { PatchError } from '../errors/patch.js';
import { readText } from '../utils/fs.js';
import { isNewFileInPatch, parseHunksForFile } from './patch-parse.js';

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
  const lines = content.split('\n');

  const contentLines: string[] = [];
  let inHunk = false;
  let inTargetFile = !targetFile; // If no targetFile, accept all sections
  let hasNoNewlineMarker = false;

  for (const line of lines) {
    // Track which file section we're in
    if (line.startsWith('diff --git')) {
      if (targetFile) {
        const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
        const wasInTarget = inTargetFile;
        inTargetFile = match?.[1] === targetFile;
        // If we were in the target file and hit a new diff header, we're done
        if (wasInTarget && !inTargetFile) break;
      }
      inHunk = false;
      continue;
    }

    if (!inTargetFile) continue;

    // Start of hunk
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }

    if (inHunk) {
      // Check for "No newline at end of file" marker
      if (line === '\\ No newline at end of file') {
        hasNoNewlineMarker = true;
        continue;
      }

      // Lines starting with + are added content (skip the + prefix)
      if (line.startsWith('+')) {
        contentLines.push(line.slice(1));
      }
      // Lines starting with - are removed (shouldn't exist in new file patches)
      // Context lines (no prefix) shouldn't exist in new file patches
    }
  }

  // Join lines and handle trailing newline
  const result = contentLines.join('\n');
  return hasNoNewlineMarker ? result : result + '\n';
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
  const lastHunkNoNewline = sortedHunks[0]?.noNewlineAtEnd ?? false;
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
