// SPDX-License-Identifier: EUPL-1.2

/**
 * Normalizes generated patch files before they are written to disk.
 *
 * Kept as a narrow chokepoint for future artifact-level fixes. It must keep
 * unified-diff hunk markers intact, but marker-only blank payload lines should
 * not carry extra trailing whitespace (`"+ "` / `"- "` / `"  "`), because raw
 * repository whitespace checks flag those generated patch artifact lines even
 * when the engine diff is clean.
 */
export function normalizePatchArtifact(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      if (/^[ +-]\s+$/.test(line)) {
        return line[0] ?? line;
      }
      return line;
    })
    .join('\n');
}
