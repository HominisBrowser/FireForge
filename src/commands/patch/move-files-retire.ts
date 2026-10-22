// SPDX-License-Identifier: EUPL-1.2
/**
 * `patch move-files --retire-empty`: fold every file of a patch into
 * another and retire the emptied patch's slot in the same transaction.
 *
 * Without the flag `move-files` refuses to empty the source, and
 * `patch retire` on an emptied patch refuses while another patch's
 * declaration still names it as the owner. With the flag the move re-points
 * those declarations to the destination first (after the fold the
 * destination creates every file the source did), carries the source's own declarations over with its files, and then
 * retires the source the way `patch retire` does: the row and `.patch` file
 * leave, and the order stays spent as a `patches.json#retired` slot so
 * `patchPolicy.allowGaps: false` sees no gap.
 */

import { rewriteStagedDependencyOwners } from '../../core/patch-manifest.js';
import type {
  PatchMetadata,
  PatchRetiredSlot,
  PatchStagedDependencies,
  PatchStagedForwardImport,
  PatchStagedRegistration,
} from '../../types/commands/index.js';

/** The rows of a fold, before the source row is retired. */
export interface FoldedRows {
  /** Every row: owners re-pointed, the destination carrying the source's declarations. */
  patches: PatchMetadata[];
  /** Patches (other than the source) whose declarations named the source as owner. */
  repointed: string[];
}

type Declaration = PatchStagedForwardImport | PatchStagedRegistration;

/**
 * Concatenates declaration lists without duplicates, dropping every entry
 * owned by `destination` itself: after the fold the file it waits for
 * arrives in the same patch, so it is no longer a forward edge.
 */
function foldDeclarations<T extends Declaration>(
  lists: ReadonlyArray<readonly T[] | undefined>,
  destination: string
): T[] {
  const keys = new Set<string>();
  const merged: T[] = [];
  for (const entry of lists.flatMap((list) => list ?? [])) {
    if (entry.owner === destination) continue;
    const key = JSON.stringify(entry);
    if (keys.has(key)) continue;
    keys.add(key);
    merged.push(entry);
  }
  return merged;
}

/** The destination row carrying its own and the source's declarations. */
function foldStaged(
  destination: PatchMetadata,
  source: PatchStagedDependencies | undefined
): PatchMetadata {
  const own = destination.stagedDependencies;
  const forwardImports = foldDeclarations(
    [own?.forwardImports, source?.forwardImports],
    destination.filename
  );
  const registrations = foldDeclarations(
    [own?.registrations, source?.registrations],
    destination.filename
  );
  const folded: PatchMetadata = { ...destination };
  delete folded.stagedDependencies;
  if (forwardImports.length === 0 && registrations.length === 0) return folded;
  folded.stagedDependencies = {
    ...(forwardImports.length > 0 ? { forwardImports } : {}),
    ...(registrations.length > 0 ? { registrations } : {}),
  };
  return folded;
}

/**
 * Re-points every declaration whose owner is `source` to `destination` and
 * carries the source's own declarations onto the destination. The source
 * row is returned unchanged; the caller retires it.
 *
 * @param patches - Manifest rows
 * @param source - Filename of the patch the fold empties
 * @param destination - Filename of the patch that receives its files
 */
export function foldSourceRows(
  patches: readonly PatchMetadata[],
  source: string,
  destination: string
): FoldedRows {
  const lookup = (owner: string): string | undefined =>
    owner === source ? destination : undefined;
  const sourceRow = patches.find((patch) => patch.filename === source);
  const sourceStaged = sourceRow
    ? rewriteStagedDependencyOwners(sourceRow, lookup).stagedDependencies
    : undefined;
  const repointed: string[] = [];
  const rows = patches.map((patch) => {
    if (patch.filename === source) return patch;
    const rewritten = rewriteStagedDependencyOwners(patch, lookup);
    if (rewritten !== patch) repointed.push(patch.filename);
    return patch.filename === destination ? foldStaged(rewritten, sourceStaged) : rewritten;
  });
  return { patches: rows, repointed };
}

/**
 * The retired slot the emptied source leaves, shaped as `patch retire`
 * writes it.
 *
 * @param source - The emptied source row
 * @param destination - Filename of the patch that took its files
 */
export function retiredSlotForFold(source: PatchMetadata, destination: string): PatchRetiredSlot {
  return {
    order: source.order,
    category: source.category,
    filename: source.filename,
    retiredAt: new Date().toISOString(),
    reason: `folded into ${destination} by patch move-files --retire-empty`,
  };
}
