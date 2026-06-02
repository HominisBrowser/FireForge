// SPDX-License-Identifier: EUPL-1.2

/**
 * Normalizes generated patch files for repository whitespace checks.
 *
 * Unified diffs conventionally encode a blank context line as a physical line
 * containing one space. `git apply` also accepts the same hunk as an empty
 * physical line, while repository-level `git diff --check` flags the
 * single-space artifact as trailing whitespace in `patches/*.patch`.
 */
export function normalizePatchArtifact(content: string): string {
  return content.replace(/^ $/gm, '');
}
