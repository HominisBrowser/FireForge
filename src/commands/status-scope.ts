// SPDX-License-Identifier: EUPL-1.2
/**
 * `status --patches <list>`: judges only the named patches' files. Split
 * out of status.ts, which sits at the max-lines budget.
 *
 * On a shared engine a peer's unexported work keeps a tree-wide gate red
 * for everyone. The scope keeps a file when the patch that owns it (or,
 * for a conflict, any patch that claims it) is named, and an ownership
 * row when any of its owners is named. An unmanaged file has no owning
 * patch, so no scope covers it: scoped runs never judge unexported files.
 * That is the point of the scope, and also its limit, which the docs say.
 */
import type { OwnershipRow } from '../core/ownership-table.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { selectPatchSubset } from '../core/patch-subset.js';
import type { ClassifiedFile, StatusFile } from '../core/status-classify.js';
import { GeneralError } from '../errors/base.js';
import { collectOwnershipRows } from './status-ownership.js';

/** The resolved `--patches` scope: manifest filenames, in request order. */
export interface StatusScope {
  patches: string[];
}

/**
 * Resolves raw `--patches` values against the manifest. Returns undefined
 * when the flag was not given, and refuses a name that matches no patch
 * (so a typo fails loud instead of judging nothing).
 *
 * @param patchesDir - Absolute path to the patches directory
 * @param requested - Raw `--patches` values (each may be a comma list)
 */
export async function resolveStatusScope(
  patchesDir: string,
  requested: readonly string[] | undefined
): Promise<StatusScope | undefined> {
  if (requested === undefined || requested.length === 0) return undefined;
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('--patches needs a patch queue, but patches.json lists no patches.');
  }
  const subset = selectPatchSubset(
    manifest,
    requested,
    '--patches selects patches (filename, stem, order number, manifest name, or slug), not engine files.'
  );
  return { patches: subset.map((patch) => patch.filename) };
}

/** True when the entry's owner, or any patch claiming it, is in scope. */
function isInScope(entry: ClassifiedFile, names: ReadonlySet<string>): boolean {
  if (entry.owner !== undefined && names.has(entry.owner)) return true;
  return entry.claimedBy?.some((patch) => names.has(patch)) === true;
}

/** Keeps only the classified entries the scope covers. No scope keeps all. */
export function scopeClassified(
  classified: ClassifiedFile[],
  scope: StatusScope | undefined
): ClassifiedFile[] {
  if (scope === undefined) return classified;
  const names = new Set(scope.patches);
  return classified.filter((entry) => isInScope(entry, names));
}

/** Keeps only the ownership rows with an owner in scope. No scope keeps all. */
export function scopeOwnershipRows(
  rows: OwnershipRow[],
  scope: StatusScope | undefined
): OwnershipRow[] {
  if (scope === undefined) return rows;
  const names = new Set(scope.patches);
  return rows.filter((row) => row.owners.some((owner) => names.has(owner)));
}

/**
 * Builds the ownership rows from the full scan (classification needs every
 * file to find claims), then narrows them to the scope.
 */
export async function collectScopedOwnershipRows(
  patchesDir: string,
  files: StatusFile[],
  classified: readonly ClassifiedFile[],
  scope: StatusScope | undefined
): Promise<OwnershipRow[]> {
  const rows = await collectOwnershipRows(
    patchesDir,
    (await loadPatchesManifest(patchesDir))?.patches ?? [],
    files,
    classified
  );
  return scopeOwnershipRows(rows, scope);
}

/** The paths the `ownership-conflict` check class judges. */
export function ownershipConflictPaths(rows: readonly OwnershipRow[]): string[] {
  return rows.filter((row) => row.conflict).map((row) => row.path);
}
