// SPDX-License-Identifier: EUPL-1.2

/**
 * Normalizes generated patch files before they are written to disk.
 *
 * Currently the identity function, kept as a narrow chokepoint for future
 * artifact-level fixes so every export path (`commitExportedPatch`,
 * `commitPlacementExport`, `updatePatch`, `patch split`) funnels through
 * one place.
 *
 * History: this used to strip marker lines whose payload was pure
 * whitespace (`/^[ +-]\s+$/` → bare marker) to appease repository
 * trailing-whitespace checks. That corrupted real content — Firefox
 * sources contain whitespace-only lines, so a ` `/`-` line whose payload
 * was e.g. two spaces no longer matched the pristine tree (the freshly
 * exported patch failed `git apply --check`), and a `+` line silently
 * changed what the patch produces, making re-import diverge from the
 * engine state it was exported from (2026-07-05 review, finding M2).
 * The whitespace check itself excludes `patches/*.patch`
 * (scripts/check-worktree-whitespace.mjs), so the trimming had no
 * remaining justification. Patch bodies are now written byte-for-byte as
 * git produced them — including the single-space rendering of blank
 * context lines, which `re-export.integration.test.ts` pins.
 */
export function normalizePatchArtifact(content: string): string {
  return content;
}
