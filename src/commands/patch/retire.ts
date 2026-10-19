// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch retire <name>`: removes a patch from the queue and keeps
 * its order number spent as a retired slot in `patches.json#retired`.
 *
 * The case it exists for: a rename leaves a patch owning only files that no
 * longer exist. `patch delete` opens a numeric gap that
 * `patchPolicy.allowGaps: false` refuses, and `patch compact` renumbers
 * every later patch, including ones a peer session has in flight. Retiring
 * removes the patch file and row like a delete, and records the order as a
 * placeholder the gap check counts as occupied. Nothing else reads the
 * placeholder (see `core/patch-retired.ts`), and a later
 * `export --order <n>` that takes the number fills it.
 *
 * Shares the delete's dependency refusal, dry-run, confirmation and history
 * contract, so the two differ only in what happens to the order number.
 */

import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { confirmDestructive } from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { removePatchFileAndManifest } from '../../core/patch-manifest.js';
import { formatPatchOrder } from '../../core/patch-parse.js';
import { GeneralError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchRetiredSlot, PatchRetireOptions } from '../../types/commands/index.js';
import { info, intro, outro } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';
import {
  deleteCreatedFiles,
  planClaimedFiles,
  withCreatedFileLock,
} from './removal-created-files.js';
import {
  collectRemovalDependents,
  queueSnapshot,
  removalConflict,
  warnDanglingStagedOwners,
} from './removal-dependents.js';

/**
 * Runs the `patch retire` command.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename, ordinal, or manifest name to retire
 * @param options - Command options
 */
export async function patchRetireCommand(
  projectRoot: string,
  identifier: string,
  options: PatchRetireOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch retire (dry run)' : 'FireForge patch retire');

  const { paths, manifest } = await requirePatchQueue(projectRoot, {
    missingDirMessage: 'Patches directory not found. No patches to retire.',
  });
  const target = requirePatchTarget(identifier, manifest.patches);

  const baseCtx = await buildPatchQueueContext(paths.patches);
  const dependents = collectRemovalDependents(baseCtx, target, {
    noun: 'retirement',
    verb: 'retire',
  });
  warnDanglingStagedOwners(baseCtx, target, 'retire');

  const order = formatPatchOrder(target.order);
  const claimed = await planClaimedFiles(
    baseCtx,
    target,
    paths.engine,
    options.deleteCreated === true
  );
  const summary: string[] = [
    `retire ${target.filename}  (category: ${target.category}, order: ${order})`,
    `description: ${target.description || '(none)'}`,
    `order ${order} stays spent as a retired slot in patches.json; ` +
      `"fireforge export --order ${order}" can fill it later`,
    ...claimed.summary,
  ];

  const decision = await confirmDestructive({
    operation: 'patch-retire',
    title: `Retire ${target.filename}`,
    summary,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts: removalConflict(dependents, target),
  });

  if (!proceedAfterDecision(decision, 'Retire cancelled')) return;

  const slot: PatchRetiredSlot = {
    order: target.order,
    category: target.category,
    filename: target.filename,
    retiredAt: new Date().toISOString(),
    ...(options.reason !== undefined ? { reason: options.reason } : {}),
  };

  // Same locking and history contract as `patch delete`: the dependency
  // scan approved before the prompt is re-checked under the lock, and the
  // history record is appended inside it.
  const waitLockSeconds = resolveWaitLockSeconds(options.waitLock);
  await withCreatedFileLock(projectRoot, 'patch retire', claimed, waitLockSeconds, () =>
    withPatchDirectoryLock(
      paths.patches,
      async () => {
        const current = await buildPatchQueueContext(paths.patches);
        if (queueSnapshot(current) !== queueSnapshot(baseCtx)) {
          throw new GeneralError(
            'Patch queue changed while waiting for confirmation or the lock. Re-run patch retire to review the current dependencies.'
          );
        }
        await removePatchFileAndManifest(paths.patches, target.filename, slot);
        await deleteCreatedFiles(paths.engine, claimed.deleteOnCommit);
        await appendHistoryBestEffort(
          paths.patches,
          {
            operation: 'patch-retire',
            args: {
              filename: target.filename,
              order: target.order,
              filesAffected: target.filesAffected,
              ...(claimed.deleteOnCommit.length > 0
                ? { deletedCreatedFiles: claimed.deleteOnCommit }
                : {}),
              ...(options.reason !== undefined ? { reason: options.reason } : {}),
            },
            ...(options.yes === true ? { yes: true } : {}),
            ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
            result: 'ok',
          },
          `patch retire committed (${target.filename})`
        );
      },
      { waitLockSeconds, command: 'patch retire' }
    )
  );

  info(`Retired ${target.filename}; order ${order} is kept as a retired slot.`);
  if ((await loadConfig(projectRoot)).patchPolicy?.allowGaps !== false) {
    info(
      'patchPolicy.allowGaps is not false, so no check reads the retired slot; ' +
        '"patch delete" would have had the same effect on this queue.'
    );
  }
  outro('Retire complete');
}

/**
 * Registers the `patch retire` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchRetire(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('retire <name>')
    .description(
      'Remove a patch from the queue but keep its order number as a retired slot, ' +
        'so patchPolicy.allowGaps: false sees no gap and no later patch is renumbered (destructive)'
    )
    .option('--reason <text>', 'Rationale recorded on the retired slot')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option(
      '--delete-created',
      'Also delete the engine files this patch creates that are still on disk, instead of leaving them unmanaged'
    )
    .option(
      '--force-unsafe',
      'Bypass the refusal when a later patch depends on this patch (last resort)'
    );
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        name: string,
        options: {
          reason?: string;
          dryRun?: boolean;
          yes?: boolean;
          forceUnsafe?: boolean;
          deleteCreated?: boolean;
          waitLock?: number | boolean;
        }
      ) => {
        await patchRetireCommand(getProjectRoot(), name, pickDefined(options));
      }
    )
  );
}
