// SPDX-License-Identifier: EUPL-1.2
/**
 * Rename-map helpers shared by `patch reorder` (single-patch moves and
 * `--shift`), `patch compact` and `patch rename --order`: the filename a
 * patch takes at a new order, and the queue context projected through a
 * rename map for cross-patch lint.
 */

import type { PatchQueueContext, PatchQueueEntry } from '../../core/patch-lint.js';
import { type PatchRenameEntry, rewriteStagedDependencyOwners } from '../../core/patch-manifest.js';
import type { PatchMetadata } from '../../types/commands/index.js';

/** Zero-pads an ordinal number to the given width. */
function padOrder(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Builds a new patch filename by replacing the numeric prefix with `newOrder`. */
export function rebuildFilenameForOrder(existing: PatchMetadata, newOrder: number): string {
  const currentPrefixMatch = /^(\d+)-/.exec(existing.filename);
  const currentPrefix = currentPrefixMatch?.[1] ?? '001';
  const width = Math.max(3, currentPrefix.length, String(newOrder).length);
  const rest = existing.filename.replace(/^\d+-/, '');
  return `${padOrder(newOrder, width)}-${rest}`;
}

/**
 * Applies a rename map to a {@link PatchQueueContext} so cross-patch lint
 * can run against the projected state without touching disk. Exported for
 * `patch rename --order`, which projects the same single-row move shape.
 */
export function projectReorder(
  base: PatchQueueContext,
  renameMap: Map<string, PatchRenameEntry>
): PatchQueueContext {
  const ownerLookup = (oldFilename: string): string | undefined =>
    renameMap.get(oldFilename)?.newFilename;
  const projectedEntries: PatchQueueEntry[] = base.entries.map((entry) => {
    // Project staged-dependency owner references through the rename map on
    // every entry. Owners point at other patches' filenames, so a
    // projection that skips non-renamed entries would lint against stale
    // owners and report false forward-import regressions.
    const metadata = entry.metadata
      ? rewriteStagedDependencyOwners(entry.metadata, ownerLookup)
      : entry.metadata;
    const rename = renameMap.get(entry.filename);
    if (!rename) {
      return metadata === entry.metadata ? entry : { ...entry, metadata };
    }
    return {
      ...entry,
      metadata,
      filename: rename.newFilename,
      order: rename.newOrder,
    };
  });
  projectedEntries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  return { entries: projectedEntries };
}
