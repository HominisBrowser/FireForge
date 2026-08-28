// SPDX-License-Identifier: EUPL-1.2

/**
 * Normalizes generated patch files before they are written to disk.
 *
 * Currently the identity function, kept as a narrow chokepoint for future
 * artifact-level fixes so every export path (`commitExportedPatch`,
 * `commitPlacementExport`, `updatePatch`, `patch split`) funnels through one
 * place.
 *
 * **Do not reintroduce whitespace trimming here.** Stripping marker lines
 * whose payload is pure whitespace (`/^[ +-]\s+$/` → bare marker) corrupts
 * real content: Firefox sources contain whitespace-only lines, so a ` `/`-`
 * line whose payload was e.g. two spaces no longer matches the pristine tree
 * (the freshly exported patch fails `git apply --check`), and a `+` line
 * silently changes what the patch produces, making re-import diverge from
 * the engine state it was exported from. The repository whitespace check
 * already excludes `patches/*.patch`
 * (scripts/check-worktree-whitespace.mjs). Patch bodies are written
 * byte-for-byte as git produced them, including the single-space rendering
 * of blank context lines, which `re-export.integration.test.ts` pins.
 */
export function normalizePatchArtifact(content: string): string {
  return content;
}
