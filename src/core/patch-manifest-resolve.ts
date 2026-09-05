// SPDX-License-Identifier: EUPL-1.2
import type { PatchMetadata } from '../types/commands/index.js';

/**
 * Resolves a patch identifier to its manifest entry. Accepts:
 *
 *   1. An ordinal number (e.g. `2`), matching `PatchMetadata.order`.
 *   2. A full filename with `.patch` suffix (e.g. `002-ui-foo.patch`),
 *      matching `PatchMetadata.filename`.
 *   3. A filename without the `.patch` suffix. The command appends it
 *      before matching (e.g. `002-ui-foo`).
 *   4. The manifest `name` field (e.g. `furnace-token-override`), the short
 *      logical handle the export workflow stamps onto the patch and the
 *      natural identifier an operator keeps in their notes. The CLI help
 *      says `<name>`, so rejecting it forces the operator to copy the full
 *      filename out of `patches.json` before every queue mutation.
 *
 * Resolution order is strict: numeric ordinals first, then filename lookup
 * (with and without the `.patch` suffix), then name-field lookup. The
 * filename lookup beats the name lookup when the two collide, so scripts
 * that pass filenames keep working.
 */
export function resolvePatchIdentifier(
  identifier: string,
  patches: PatchMetadata[]
): PatchMetadata | null {
  if (/^\d+$/.test(identifier)) {
    const order = parseInt(identifier, 10);
    return patches.find((p) => p.order === order) ?? null;
  }
  // Filename lookup: try the input as-is first (covers both the
  // full `.patch` form and a bare name, because `endsWith` treats the
  // bare form as a miss and falls through to the appended variant).
  const normalized = identifier.endsWith('.patch') ? identifier : `${identifier}.patch`;
  const byFilename = patches.find((p) => p.filename === normalized || p.filename === identifier);
  if (byFilename) return byFilename;
  // Name-field lookup: the short logical handle stamped into the
  // manifest at export time. See function docstring.
  return patches.find((p) => p.name === identifier) ?? null;
}
