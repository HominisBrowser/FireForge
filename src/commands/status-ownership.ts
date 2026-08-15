// SPDX-License-Identifier: EUPL-1.2
/**
 * Ownership-table assembly for `status`, split out of `status.ts` (FORGE
 * L3) so the human `--ownership` mode and the additive `ownership` block on
 * the `--json` payload build the SAME rows from the SAME scan.
 *
 * Before L3 the `--ownership` branch re-implemented the shared scan and
 * inlined a second copy of the classification call, then discarded
 * everything but each file's classification — three back-to-back `status`
 * invocations in a gate therefore paid three full worktree scans. Both
 * callers now hand this module the already-classified files.
 *
 * No renderer lives here: `renderOwnershipTable` (human) and the JSON
 * serializer stay with their respective output layers.
 */

import type { OwnershipRow } from '../core/ownership-table.js';
import { buildOwnershipTable } from '../core/ownership-table.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from '../core/patch-lint.js';
import type { ClassifiedFile, StatusFile } from '../core/status-classify.js';
import type { PatchMetadata } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';

/** Counts the human outro prints and the JSON block carries. */
export interface OwnershipSummary {
  managed: number;
  unmanaged: number;
  conflicts: number;
}

/** The additive `ownership` block on the schemaVersion-1 JSON payload. */
export interface OwnershipJsonBlock {
  rows: OwnershipRow[];
  summary: OwnershipSummary;
}

/**
 * Builds the flat path→owning-patch rows. Sources are the manifest's
 * `filesAffected`, worktree drift, and the cross-patch
 * duplicate-new-file-creation map produced by walking each patch body —
 * the last being the alignment fix between `status --ownership` and
 * `fireforge verify` (see `buildOwnershipTable`'s header).
 * @param patchesDir - Path to the patches directory
 * @param manifestPatches - Patch rows from patches.json (empty when absent)
 * @param files - Scanned worktree entries, temp-filtered
 * @param classified - The same entries, already classified
 */
export async function collectOwnershipRows(
  patchesDir: string,
  manifestPatches: readonly PatchMetadata[],
  files: StatusFile[],
  classified: readonly ClassifiedFile[]
): Promise<OwnershipRow[]> {
  // Only walk patch bodies when the directory actually exists: a fresh
  // project with no queue degrades to filesAffected-only behavior.
  const newFileCreatorsByPath = (await pathExists(patchesDir))
    ? collectNewFileCreatorsByPath(await buildPatchQueueContext(patchesDir))
    : new Map<string, string[]>();

  return buildOwnershipTable(
    [...manifestPatches],
    files,
    newFileCreatorsByPath,
    new Map(classified.map((entry) => [entry.file, entry.classification]))
  );
}

/**
 * Counts managed / unmanaged / conflicted rows. Conflicts are rows flagged
 * `conflict`, not a separate collection.
 * @param rows - Rows from {@link collectOwnershipRows}
 */
export function summarizeOwnership(rows: readonly OwnershipRow[]): OwnershipSummary {
  return {
    managed: rows.filter((r) => !r.unmanaged).length,
    unmanaged: rows.filter((r) => r.unmanaged).length,
    conflicts: rows.filter((r) => r.conflict).length,
  };
}

/**
 * Assembles the JSON block. Rows are carried verbatim so the machine shape
 * and the rendered table can never disagree.
 * @param rows - Rows from {@link collectOwnershipRows}
 */
export function buildOwnershipJsonBlock(rows: OwnershipRow[]): OwnershipJsonBlock {
  return { rows, summary: summarizeOwnership(rows) };
}
