// SPDX-License-Identifier: EUPL-1.2
/**
 * Unified-diff walking helpers shared between per-patch lint rules,
 * cross-patch lint rules, and the export / re-export projection paths.
 *
 * Factored out of `patch-lint.ts` so the per-patch lint body and
 * cross-patch lint body (in `patch-lint-cross.ts`) can both depend on
 * the same diff walkers without inducing a circular import. Callers
 * should keep importing these through `patch-lint.ts` — this file is
 * an implementation detail. The actual line-walking lives in
 * `parseDiffSections` (patch-parse.ts), the codebase's single diff walker.
 */

import { parseDiffSections } from './patch-parse.js';

/**
 * Extracts new-file paths from a unified diff by scanning for `new file mode` markers.
 */
export function detectNewFilesInDiff(diffContent: string): Set<string> {
  const newFiles = new Set<string>();
  for (const section of parseDiffSections(diffContent)) {
    if (section.isNewFile) {
      newFiles.add(section.targetPath);
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
  for (const section of parseDiffSections(diffContent)) {
    for (const hunk of section.hunks) {
      for (const line of hunk.lines) {
        if (!line.startsWith('+')) continue;
        let arr = result.get(section.targetPath);
        if (!arr) {
          arr = [];
          result.set(section.targetPath, arr);
        }
        arr.push(line.slice(1));
      }
    }
  }
  return result;
}

/**
 * Extracts 1-based post-patch line numbers of added lines per file from a
 * unified diff. Walking each hunk with a new-file line counter (`+` and
 * context lines advance it, `-` lines do not) lets rules that need
 * full-file context — e.g. comment masking across the context/added
 * boundary — map the patch's additions onto the applied file.
 */
export function extractAddedLineNumbersPerFile(diffContent: string): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const section of parseDiffSections(diffContent)) {
    for (const hunk of section.hunks) {
      let newLine = hunk.newStart;
      for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue; // "\ No newline at end of file"
        if (line.startsWith('-')) continue;
        if (line.startsWith('+')) {
          let arr = result.get(section.targetPath);
          if (!arr) {
            arr = [];
            result.set(section.targetPath, arr);
          }
          arr.push(newLine);
        }
        newLine++;
      }
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
