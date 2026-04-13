// SPDX-License-Identifier: EUPL-1.2
import type { PatchMetadata } from '../types/commands/index.js';
import { info } from '../utils/logger.js';

/**
 * A row in the flat path → owning-patch ownership table.
 */
export interface OwnershipRow {
  path: string;
  owners: string[]; // manifest filenames
  conflict: boolean;
  conflictReason: 'files-affected' | 'duplicate-create' | null;
  unmanaged: boolean;
}

interface StatusFile {
  status: string;
  file: string;
}

/**
 * Builds the flat ownership table from the manifest, worktree status, and
 * the duplicate-new-file-creation map produced by cross-patch lint.
 *
 * Populated from three sources:
 *
 *   1. Every path in every patch's `filesAffected` — so managed paths
 *      show up even when they are not currently modified on disk.
 *   2. Any worktree status entries not claimed by any patch (flagged as
 *      `unmanaged`).
 *   3. Paths created by more than one patch in `new file mode`,
 *      surfaced as ownership conflicts with
 *      `conflictReason = 'duplicate-create'`. This is the alignment
 *      fix between `status --ownership` and `fireforge verify`: a
 *      queue that `verify` rejects for duplicate `/dev/null → b/foo.js`
 *      creations was previously reported as clean here because the
 *      check only walked `filesAffected`, not the patch bodies.
 *
 * A path claimed by more than one patch (either via `filesAffected` or
 * as a duplicate creation) is flagged as `conflict` with the origin
 * recorded in `conflictReason` so the output can disambiguate.
 *
 * @param manifestPatches - Manifest rows, each with its `filesAffected`
 * @param worktreeFiles - Raw worktree status entries; untracked and
 *   modified both acceptable
 * @param newFileCreatorsByPath - Map produced by
 *   {@link import('../core/patch-lint.js').collectNewFileCreatorsByPath};
 *   paths with a `.length > 1` owner list become duplicate-create conflicts
 */
export function buildOwnershipTable(
  manifestPatches: PatchMetadata[],
  worktreeFiles: StatusFile[],
  newFileCreatorsByPath: Map<string, string[]>
): OwnershipRow[] {
  const ownersByPath = new Map<string, string[]>();
  for (const patch of manifestPatches) {
    for (const file of patch.filesAffected) {
      const existing = ownersByPath.get(file) ?? [];
      existing.push(patch.filename);
      ownersByPath.set(file, existing);
    }
  }

  // Merge duplicate-new-file-creation findings. The structured helper
  // returns all new-file paths, so we filter to the ones with more
  // than one creator. Paths are added to the table even when no patch
  // listed them in `filesAffected`, because the two-patch duplicate
  // creation is exactly the shape that manifests as an ownership
  // conflict without showing up in filesAffected (e.g. drift caused
  // by manual patches.json editing).
  const duplicateCreateByPath = new Map<string, string[]>();
  for (const [path, creators] of newFileCreatorsByPath) {
    if (creators.length <= 1) continue;
    duplicateCreateByPath.set(path, creators);
    if (!ownersByPath.has(path)) {
      ownersByPath.set(path, [...creators]);
    }
  }

  const worktreeSet = new Set(worktreeFiles.map((f) => f.file));
  const unmanagedOnly: string[] = [];
  for (const path of worktreeSet) {
    if (!ownersByPath.has(path)) {
      unmanagedOnly.push(path);
    }
  }

  const rows: OwnershipRow[] = [];
  for (const [path, owners] of ownersByPath) {
    const duplicateOwners = duplicateCreateByPath.get(path);
    const isFilesAffectedConflict = owners.length > 1;
    const isDuplicateCreateConflict = duplicateOwners !== undefined;
    // Prefer the filesAffected reason when both apply — it's the older
    // source of drift and the operator will usually want to fix the
    // manifest rows even when the bodies also duplicate-create.
    const conflictReason: OwnershipRow['conflictReason'] = isFilesAffectedConflict
      ? 'files-affected'
      : isDuplicateCreateConflict
        ? 'duplicate-create'
        : null;
    // If the duplicate-create finding introduced new patches not in
    // filesAffected, merge them into owners so the rendered cell lists
    // everyone responsible for the conflict, matching what `verify`
    // prints.
    const mergedOwners = duplicateOwners
      ? Array.from(new Set([...owners, ...duplicateOwners])).sort((a, b) => a.localeCompare(b))
      : owners;
    rows.push({
      path,
      owners: mergedOwners,
      conflict: isFilesAffectedConflict || isDuplicateCreateConflict,
      conflictReason,
      unmanaged: false,
    });
  }
  for (const path of unmanagedOnly) {
    rows.push({
      path,
      owners: [],
      conflict: false,
      conflictReason: null,
      unmanaged: true,
    });
  }

  rows.sort((a, b) => a.path.localeCompare(b.path));
  return rows;
}

/**
 * Human-readable label for the conflict column. Distinguishes
 * `files-affected` drift (two manifest rows claiming the same path) from
 * `duplicate-create` drift (two patches both hitting `/dev/null → b/path`
 * in their bodies) so the operator can tell at a glance which fix
 * applies — the former wants `re-export --files`, the latter wants
 * `patch delete`.
 */
function renderConflictCell(row: OwnershipRow): string {
  if (!row.conflict) return row.unmanaged ? 'unmanaged' : '';
  if (row.conflictReason === 'duplicate-create') return 'CONFLICT (dup-create)';
  return 'CONFLICT';
}

/**
 * Renders the ownership table as a GitHub-flavored Markdown pipe table.
 * Using markdown-table's own serializer would require a seed document to
 * graft onto, which is overkill for ad-hoc status output; the rendering
 * here is trivial enough to inline.
 */
export function renderOwnershipTable(rows: OwnershipRow[]): void {
  if (rows.length === 0) {
    info('No tracked or modified files.');
    return;
  }

  const pathHeader = 'path';
  const ownerHeader = 'owning patch';
  const conflictHeader = 'conflict';

  const pathWidth = Math.max(pathHeader.length, ...rows.map((r) => r.path.length));
  const ownerWidth = Math.max(
    ownerHeader.length,
    ...rows.map((r) => (r.unmanaged ? 1 : r.owners.join(', ').length))
  );
  const conflictWidth = Math.max(
    conflictHeader.length,
    ...rows.map((r) => renderConflictCell(r).length),
    8
  );

  const pad = (text: string, width: number): string => text + ' '.repeat(width - text.length);

  info(
    `| ${pad(pathHeader, pathWidth)} | ${pad(ownerHeader, ownerWidth)} | ${pad(conflictHeader, conflictWidth)} |`
  );
  info(`| ${'-'.repeat(pathWidth)} | ${'-'.repeat(ownerWidth)} | ${'-'.repeat(conflictWidth)} |`);

  for (const row of rows) {
    const ownerCell = row.unmanaged ? '-' : row.owners.join(', ');
    const conflictCell = renderConflictCell(row);
    info(
      `| ${pad(row.path, pathWidth)} | ${pad(ownerCell, ownerWidth)} | ${pad(conflictCell, conflictWidth)} |`
    );
  }
}
