// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch compact` — closes ordinal gaps in the patch queue.
 *
 * After deletes or splits, patch ordinals may have gaps (e.g. 1, 3, 7).
 * This command renumbers patches to close those gaps in a single atomic
 * operation, preserving relative order. Without a patch policy the whole
 * queue is renumbered from 1; with `patchPolicy.ranges` configured the
 * compaction is range-aware (each category range compacts independently,
 * reserved ranges and out-of-range strays are left untouched).
 */

import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
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
import type { PatchPolicyConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { requirePatchQueue } from './patch-context.js';
import { rebuildFilenameForOrder } from './reorder.js';

/** True when `order` falls inside a configured reserved range. */
function isReservedOrder(policyCfg: PatchPolicyConfig, order: number): boolean {
  return (policyCfg.reservedRanges ?? []).some((r) => order >= r.from && order <= r.to);
}

/**
 * Computes a rename map that closes ordinal gaps.
 *
 * Without a patch policy, all patches are renumbered to 1, 2, 3, … in
 * current sort order (historical behaviour). With `patchPolicy.ranges`
 * configured, compaction happens *within* each category range instead:
 * each range's members are renumbered consecutively starting at the
 * range's first occupied ordinal, skipping reserved orders — mirroring
 * what `evaluateGaps` treats as gapless under `allowGaps: false`.
 * Reserved-range patches and patches outside their category's range are
 * never moved (a global renumber would project them across range
 * boundaries and trip `category-range` refusals).
 */
function computeCompactRenameMap(
  patches: PatchMetadata[],
  policyCfg?: PatchPolicyConfig
): Map<string, PatchRenameEntry> {
  if (!policyCfg || policyCfg.ranges.length === 0) {
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

  const renames = new Map<string, PatchRenameEntry>();
  for (const range of policyCfg.ranges) {
    const members = patches
      .filter(
        (p) =>
          p.category === range.category &&
          p.order >= range.from &&
          p.order <= range.to &&
          !isReservedOrder(policyCfg, p.order)
      )
      .sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
    if (members.length === 0) continue;

    // Anchor at the first occupied ordinal rather than range.from: gap
    // evaluation only requires contiguity between first and last occupied,
    // and anchoring minimizes renames.
    let next = (members[0] as PatchMetadata).order;
    for (const patch of members) {
      while (isReservedOrder(policyCfg, next)) next++;
      if (patch.order !== next) {
        renames.set(patch.filename, {
          newOrder: next,
          newFilename: rebuildFilenameForOrder(patch, next),
        });
      }
      next++;
    }
  }
  return renames;
}

/**
 * Patches a range-aware compact leaves in place because they sit outside
 * their category's configured range (or outside all ranges) without a
 * reserved-range exception. They already violate `category-range`; moving
 * them is a policy decision compact must not make silently.
 */
function findCompactStrays(
  patches: PatchMetadata[],
  policyCfg: PatchPolicyConfig
): PatchMetadata[] {
  return patches.filter((p) => {
    if (isReservedOrder(policyCfg, p.order)) return false;
    return !policyCfg.ranges.some(
      (range) => range.category === p.category && p.order >= range.from && p.order <= range.to
    );
  });
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

  const config = await loadConfig(projectRoot);
  const { paths, manifest } = await requirePatchQueue(projectRoot);

  const policyCfg = config.patchPolicy;
  if (policyCfg && policyCfg.ranges.length > 0) {
    const strays = findCompactStrays(manifest.patches, policyCfg);
    for (const stray of strays) {
      warn(
        `${stray.filename} (order ${stray.order}, category ${stray.category}) sits outside its ` +
          'configured category range; compact leaves it in place. Use "fireforge patch reorder" ' +
          'to move it into range first.'
      );
    }
  }

  const renameMap = computeCompactRenameMap(manifest.patches, policyCfg);
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
  if (decision === 'declined') {
    outro('Compact cancelled');
    return;
  }

  await withPatchDirectoryLock(
    paths.patches,
    async () => {
      const currentManifest = await loadPatchesManifest(paths.patches);
      if (!currentManifest) {
        throw new GeneralError('Manifest disappeared while waiting for lock.');
      }

      const currentRenameMap = computeCompactRenameMap(currentManifest.patches, policyCfg);
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
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch compact' }
  );

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
  const command = parent
    .command('compact')
    .description(
      'Close ordinal gaps in the patch queue (range-aware when patchPolicy.ranges is configured)'
    )
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass force-mode patchPolicy refusals');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (options: {
        dryRun?: boolean;
        yes?: boolean;
        forceUnsafe?: boolean;
        waitLock?: number | boolean;
      }) => {
        await patchCompactCommand(getProjectRoot(), pickDefined(options));
      }
    )
  );
}
