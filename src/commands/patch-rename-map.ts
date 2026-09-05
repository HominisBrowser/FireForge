// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural equality for patch rename maps, shared by the placement-mode
 * export preview/commit check (`export-flow.ts`) and `patch reorder`'s
 * under-lock drift check. Both previously carried a byte-identical copy of
 * the sorted-entries comparison; one helper keeps the two commit gates from
 * drifting.
 */

import type { PatchRenameEntry } from '../core/patch-manifest.js';

/**
 * Rename-map entries ordered by target order, so previews, history entries
 * and equality checks all walk the queue in its final on-disk order.
 */
export function getSortedRenameEntries(
  renameMap: Map<string, PatchRenameEntry>
): Array<[string, PatchRenameEntry]> {
  return Array.from(renameMap.entries()).sort((a, b) => a[1].newOrder - b[1].newOrder);
}

/**
 * Compares two rename maps entry by entry after sorting both by target
 * order. Equal when every (current filename, new filename, new order)
 * triple matches positionally.
 */
export function renameMapsEqual(
  left: Map<string, PatchRenameEntry>,
  right: Map<string, PatchRenameEntry>
): boolean {
  const leftEntries = getSortedRenameEntries(left);
  const rightEntries = getSortedRenameEntries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftFilename, leftEntry], index) => {
    const rightTuple = rightEntries[index];
    if (!rightTuple) return false;
    const [rightFilename, rightEntry] = rightTuple;
    return (
      leftFilename === rightFilename &&
      leftEntry.newFilename === rightEntry.newFilename &&
      leftEntry.newOrder === rightEntry.newOrder
    );
  });
}
