// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch compact` — closes ordinal gaps in the patch queue.
 *
 * After deletes or splits, patch ordinals may have gaps (e.g. 1, 3, 7).
 * This command renumbers all patches to sequential ordinals (1, 2, 3, …)
 * in a single atomic operation, preserving relative order.
 */

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { appendHistory, confirmDestructive, type HistoryEntry } from '../../core/destructive.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  type PatchRenameEntry,
  renumberPatchesInManifest,
} from '../../core/patch-manifest.js';
import { applyRenameMapToManifest, enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchCompactOptions, PatchMetadata } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { pickDefined } from '../../utils/options.js';
import { rebuildFilenameForOrder } from './reorder.js';

/**
 * Computes a rename map that assigns sequential ordinals (1, 2, 3, …)
 * to all patches, sorted by their current order.
 */
function computeCompactRenameMap(patches: PatchMetadata[]): Map<string, PatchRenameEntry> {
  const sorted = [...patches].sort((a, b) => a.order - b.order);
  const renames = new Map<string, PatchRenameEntry>();

  for (const [i, patch] of sorted.entries()) {
    const newOrder = i + 1;
    if (patch.order !== newOrder) {
      renames.set(patch.filename, {
        newOrder,
        newFilename: rebuildFilenameForOrder(patch, newOrder),
      });
    }
  }

  return renames;
}

/**
 * Runs the `patch compact` command: renumbers all patches to close ordinal
 * gaps in a single atomic operation.
 *
 * @param projectRoot - Project root directory
 * @param options - Command options
 */
export async function patchCompactCommand(
  projectRoot: string,
  options: PatchCompactOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch compact (dry run)' : 'FireForge patch compact');

  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const renameMap = computeCompactRenameMap(manifest.patches);
  if (renameMap.size === 0) {
    info('Patch queue is already compact. Nothing to do.');
    outro('Compact complete (no-op)');
    return;
  }

  const sorted = [...renameMap.entries()].sort((a, b) => a[1].newOrder - b[1].newOrder);

  const summary: string[] = [`${renameMap.size} patch(es) would be renumbered:`];
  for (const [oldFilename, entry] of sorted) {
    summary.push(`  ${oldFilename}  →  ${entry.newFilename}  (order ${entry.newOrder})`);
  }

  enforcePatchPolicy({
    config,
    manifest: applyRenameMapToManifest(manifest, renameMap),
    command: 'patch compact',
    forceUnsafe: options.forceUnsafe === true,
  });

  const decision = await confirmDestructive({
    operation: 'patch-compact',
    title: `Compact ${manifest.patches.length} patches (${renameMap.size} rename(s))`,
    summary,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
  });

  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'cancelled') {
    outro('Compact cancelled');
    return;
  }

  await withPatchDirectoryLock(paths.patches, async () => {
    const currentManifest = await loadPatchesManifest(paths.patches);
    if (!currentManifest) {
      throw new GeneralError('Manifest disappeared while waiting for lock.');
    }

    const currentRenameMap = computeCompactRenameMap(currentManifest.patches);
    if (currentRenameMap.size === 0) {
      info('Patch queue was compacted by another process. Nothing to do.');
      return;
    }

    enforcePatchPolicy({
      config,
      manifest: applyRenameMapToManifest(currentManifest, currentRenameMap),
      command: 'patch compact',
      forceUnsafe: options.forceUnsafe === true,
    });

    await renumberPatchesInManifest(paths.patches, currentRenameMap);

    const historyEntry: HistoryEntry = {
      operation: 'patch-compact',
      args: {
        renames: [...currentRenameMap.entries()]
          .sort((a, b) => a[1].newOrder - b[1].newOrder)
          .map(([from, entry]) => ({
            from,
            to: entry.newFilename,
            order: entry.newOrder,
          })),
      },
      ...(options.yes === true ? { yes: true } : {}),
      ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
      result: 'ok',
    };

    try {
      await appendHistory(paths.patches, historyEntry);
    } catch (historyError: unknown) {
      warn(
        `History log append failed after patch compact committed: ${toError(historyError).message}`
      );
    }
  });

  info(`Compacted ${renameMap.size} patch(es).`);
  outro('Compact complete');
}

/**
 * Registers the `patch compact` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchCompact(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('compact')
    .description('Close ordinal gaps in the patch queue (renumber sequentially)')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass force-mode patchPolicy refusals')
    .action(
      withErrorHandling(
        async (options: { dryRun?: boolean; yes?: boolean; forceUnsafe?: boolean }) => {
          await patchCompactCommand(getProjectRoot(), pickDefined(options));
        }
      )
    );
}
