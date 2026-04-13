// SPDX-License-Identifier: EUPL-1.2
/**
 * Unified-diff walking helpers shared between per-patch lint rules,
 * cross-patch lint rules, and the export / re-export projection paths.
 *
 * Factored out of `patch-lint.ts` so the per-patch lint body and
 * cross-patch lint body (in `patch-lint-cross.ts`) can both depend on
 * the same diff walkers without inducing a circular import. Callers
 * should keep importing these through `patch-lint.ts` — this file is
 * an implementation detail.
 */

/**
 * Extracts new-file paths from a unified diff by scanning for `new file mode` markers.
 */
export function detectNewFilesInDiff(diffContent: string): Set<string> {
  const newFiles = new Set<string>();
  const lines = diffContent.split('\n');
  let currentFile: string | null = null;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      currentFile = match?.[1] ?? null;
      continue;
    }

    if (line.startsWith('new file mode') && currentFile) {
      newFiles.add(currentFile);
    }
  }

  return newFiles;
}

/**
 * Extracts added lines per file from a unified diff.
 * Returns a map of file path → array of added line contents (without the leading `+`).
 */
export function extractAddedLinesPerFile(diffContent: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = diffContent.split('\n');
  let currentFile: string | null = null;
  let inHunk = false;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = /^diff --git a\/.+ b\/(.+)$/.exec(line);
      currentFile = match?.[1] ?? null;
      inHunk = false;
      continue;
    }

    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }

    if (inHunk && currentFile && line.startsWith('+') && !line.startsWith('+++')) {
      let arr = result.get(currentFile);
      if (!arr) {
        arr = [];
        result.set(currentFile, arr);
      }
      arr.push(line.slice(1));
    }
  }

  return result;
}

/**
 * Builds the `modifiedFileAdditions` map the cross-patch lint expects for
 * a given unified diff. Exposed so callers that construct synthetic /
 * projected `PatchQueueEntry` values (notably `re-export --files`
 * and `export --order`) can populate the field identically to
 * `buildPatchQueueContext`.
 *
 * Matches buildPatchQueueContext's algorithm exactly: skip paths that are
 * created by the diff — those are already covered by the `newFiles` map,
 * which carries full content rather than only the added lines.
 *
 * @param diff - Unified diff content
 */
export function buildModifiedFileAdditionsFromDiff(diff: string): Map<string, string> {
  const newFilePaths = detectNewFilesInDiff(diff);
  const result = new Map<string, string>();
  for (const [file, lines] of extractAddedLinesPerFile(diff)) {
    if (!newFilePaths.has(file)) result.set(file, lines.join('\n'));
  }
  return result;
}
