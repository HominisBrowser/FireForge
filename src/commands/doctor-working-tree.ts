// SPDX-License-Identifier: EUPL-1.2
/**
 * Ownership-aware working-tree check for `fireforge doctor`.
 *
 * Partitions engine-tree dirtiness into `branding`, `patch-backed`,
 * `furnace`, `conflict`, and `unmanaged` buckets, and only warns on the
 * last two — everything else is tool-managed state that the operator
 * did not author directly.
 *
 * Split out of `doctor.ts` so that file stays under the per-file LOC
 * budget; see the call site in `runEngineGitChecks`.
 */

import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../core/git-status.js';
import { classifyFiles } from '../core/status-classify.js';
import type { DoctorCheck } from '../types/commands/index.js';
import type { DoctorCheckContext } from './doctor-check-core.js';
import { ok, warning } from './doctor-check-core.js';

function summarizeWorkingTreeChangeCount(changeCount: number): string {
  return `Engine working tree has ${changeCount} local change${changeCount === 1 ? '' : 's'}. Some FireForge commands assume a clean baseline and may behave differently until these are exported, discarded, or committed.`;
}

function formatManagedDetail(counts: {
  branding: number;
  furnace: number;
  patchBacked: number;
  patchOwnedDrift: number;
}): string {
  return [
    counts.patchBacked > 0 ? `${counts.patchBacked} patch-backed` : null,
    counts.patchOwnedDrift > 0 ? `${counts.patchOwnedDrift} patch-owned drift` : null,
    counts.branding > 0 ? `${counts.branding} branding` : null,
    counts.furnace > 0 ? `${counts.furnace} furnace` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');
}

/**
 * Inspects the engine working tree and returns a single `DoctorCheck`.
 * Ownership-aware: patch-backed / branding / furnace rows are reported as OK
 * with an ownership summary; unmanaged drift warns; cross-patch conflicts
 * warn loudly with a pointer at `fireforge status --ownership` +
 * `fireforge verify`.
 *
 * Ownership is what makes the advice safe: warning on every dirty row and
 * telling the operator to export/discard/reset is actively destructive on a
 * patch-backed import, where the suggested fix would drop the entire patch
 * stack. Returns `undefined` when the worktree is clean so the caller can
 * emit its own ok() row.
 */
export async function inspectEngineWorkingTree(
  ctx: DoctorCheckContext
): Promise<DoctorCheck | undefined> {
  const { paths } = ctx;
  const rawStatus = await getWorkingTreeStatus(paths.engine);
  const workingTreeStatus = await expandUntrackedDirectoryEntries(paths.engine, rawStatus);
  if (workingTreeStatus.length === 0) {
    return ok('Engine working tree');
  }

  if (!ctx.config) {
    return warning(
      'Engine working tree',
      summarizeWorkingTreeChangeCount(workingTreeStatus.length),
      'Use "fireforge status" to review changes, then export, discard, or reset them as appropriate.'
    );
  }

  const furnacePrefixes = await collectFurnaceManagedPrefixes(ctx.projectRoot);
  const classified = await classifyFiles(
    workingTreeStatus.map((entry) => ({ status: entry.status, file: entry.file })),
    paths.engine,
    paths.patches,
    ctx.config.binaryName,
    furnacePrefixes
  );

  const counts = {
    branding: 0,
    furnace: 0,
    patchBacked: 0,
    patchOwnedDrift: 0,
    conflict: 0,
    unmanaged: 0,
  };
  for (const entry of classified) {
    if (entry.classification === 'branding') counts.branding++;
    else if (entry.classification === 'furnace') counts.furnace++;
    else if (entry.classification === 'patch-backed') counts.patchBacked++;
    else if (entry.classification === 'patch-owned-drift') counts.patchOwnedDrift++;
    else if (entry.classification === 'conflict') counts.conflict++;
    else counts.unmanaged++;
  }

  if (counts.conflict > 0) {
    return warning(
      'Engine working tree',
      `Engine working tree has ${counts.conflict} cross-patch ownership conflict${counts.conflict === 1 ? '' : 's'}. Multiple patches in patches.json claim the same file.`,
      'Run "fireforge status --ownership" to see the conflicting patches, then run "fireforge verify" and resolve the overlap.'
    );
  }

  const managedTotal =
    counts.branding + counts.furnace + counts.patchBacked + counts.patchOwnedDrift;

  if (counts.unmanaged === 0) {
    const managedDetail = formatManagedDetail(counts);
    return ok(
      'Engine working tree',
      `${managedTotal} tool-managed change${managedTotal === 1 ? '' : 's'} (${managedDetail}), 0 unmanaged. Use "fireforge status --ownership" for details.`
    );
  }

  const managedTail =
    managedTotal > 0
      ? ` (${managedTotal} other change${managedTotal === 1 ? '' : 's'} are tool-managed: ${formatManagedDetail(counts)}).`
      : '';
  return warning(
    'Engine working tree',
    `Engine working tree has ${counts.unmanaged} unmanaged change${counts.unmanaged === 1 ? '' : 's'}.${managedTail}`,
    'Use "fireforge status --ownership" to separate patch-backed from unmanaged files, then export, discard, or reset only the unmanaged set.'
  );
}
