// SPDX-License-Identifier: EUPL-1.2
/**
 * Pure parsing functions for extracting information from patch files.
 * All functions are synchronous and operate on string content.
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
 * Checks whether a specific file is a new-file addition within a patch.
 * For multi-file patches, only inspects the section belonging to targetFile.
 * @param patchContent - The full patch content
 * @param targetFile - The file path to check
 * @returns true if the patch creates targetFile as a new file
 */
export function isNewFileInPatch(patchContent: string, targetFile: string): boolean {
  const lines = patchContent.split('\n');
  let inTargetFile = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      inTargetFile = match?.[1] === targetFile;
      continue;
    }

    if (!inTargetFile) continue;

    // Found hunk header — stop scanning metadata for this file section
    if (line.startsWith('@@')) break;

    if (line.startsWith('new file mode ')) {
      return true;
    }
  }

  return false;
}

/**
 * Extracts affected file paths from a diff/patch content.
 * @param diffContent - The diff content to parse
 * @returns Array of file paths
 */
export function extractAffectedFiles(diffContent: string): string[] {
  const files = new Set<string>();
  const lines = diffContent.split('\n');

  for (const line of lines) {
    // Match "diff --git a/path/to/file b/path/to/file"
    const diffMatch = /^diff --git a\/.+ b\/(.+)$/.exec(line);
    if (diffMatch?.[1]) {
      files.add(diffMatch[1]);
      continue;
    }

    // Match "+++ b/path/to/file" for new files
    const addMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (addMatch?.[1] && addMatch[1] !== '/dev/null') {
      files.add(addMatch[1]);
    }
  }

  return Array.from(files).sort();
}

/**
 * Parses hunks from a patch file for a specific target file.
 * @param patchContent - The full patch content
 * @param targetFile - The file path to extract hunks for
 * @returns Array of hunk objects with line info and changes
 */
export function parseHunksForFile(
  patchContent: string,
  targetFile: string
): Array<{
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
  noNewlineAtEnd: boolean;
}> {
  const hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
    noNewlineAtEnd: boolean;
  }> = [];

  const lines = patchContent.split('\n');
  let inTargetFile = false;
  let currentHunk: {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
    noNewlineAtEnd: boolean;
  } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Check for diff header
    if (line.startsWith('diff --git')) {
      // Check if this is for our target file
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      inTargetFile = match?.[1] === targetFile;
      currentHunk = null;
      continue;
    }

    if (!inTargetFile) continue;

    // Check for hunk header
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }
      currentHunk = {
        oldStart: parseInt(hunkMatch[1] ?? '0', 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3] ?? '0', 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
        noNewlineAtEnd: false,
      };
      continue;
    }

    // Collect hunk lines
    if (currentHunk) {
      if (line === '\\ No newline at end of file') {
        currentHunk.noNewlineAtEnd = true;
      } else if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
        currentHunk.lines.push(line);
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
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
