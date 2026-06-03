// SPDX-License-Identifier: EUPL-1.2

/**
 * Normalizes generated patch files before they are written to disk.
 *
 * Kept as a narrow chokepoint for future artifact-level fixes. It must not
 * rewrite hunk body lines: unified diffs encode a blank context line as a
 * physical line containing the leading context marker (`" "`), and FireForge's
 * verifier relies on that marker when replaying patch output.
 */
export function normalizePatchArtifact(content: string): string {
  return content;
}
