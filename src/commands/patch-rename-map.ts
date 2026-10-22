// SPDX-License-Identifier: EUPL-1.2
/**
 * Structural equality for patch rename maps, shared by the placement-mode
 * export preview/commit check (`export-flow.ts`) and `patch reorder`'s
 * under-lock drift check. One helper for the sorted-entries comparison
 * keeps the two commit gates from drifting.
 */

import { dirname, resolve } from 'node:path';

import type { PatchRenameEntry } from '../core/patch-manifest.js';
import { ensureDir, writeJson } from '../utils/fs.js';

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

/**
 * Writes a committed rename map as one JSON object, old filename to new
 * filename in the queue's new order (`{}` when nothing was renumbered), so
 * a session can rewrite its references to the renumbered patches from the
 * file instead of from the printed summary. Used by `patch reorder
 * --map-out` and `patch split --map-out`.
 *
 * @param path - Output path, relative to the working directory
 * @param renameMap - The committed rename map
 * @returns The absolute path written
 */
export async function writeRenameMapFile(
  path: string,
  renameMap: Map<string, PatchRenameEntry>
): Promise<string> {
  const absolute = resolve(path);
  await ensureDir(dirname(absolute));
  await writeJson(
    absolute,
    Object.fromEntries(
      getSortedRenameEntries(renameMap).map(([from, entry]) => [from, entry.newFilename])
    )
  );
  return absolute;
}
