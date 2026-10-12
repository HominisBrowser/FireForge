// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch delete <name>`: removes a patch from the queue.
 *
 * Destructive: refuses when a later patch imports a module owned by the
 * target (that would leave a dangling forward import), prompts for
 * confirmation interactively, requires `--yes` for non-TTY, supports
 * `--dry-run`, and appends to the patch history log on success.
 */

import { Command } from 'commander';

import { loadConfig } from '../../core/config.js';
import { confirmDestructive } from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { removePatchFileAndManifest } from '../../core/patch-manifest.js';
import { GeneralError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchDeleteOptions } from '../../types/commands/index.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { describeProjectedGaps } from './delete-gap-notice.js';
import { requirePatchQueue, requirePatchTarget } from './patch-context.js';
import {
  collectRemovalDependents,
  queueSnapshot,
  removalConflict,
  warnDanglingStagedOwners,
} from './removal-dependents.js';

/**
 * Runs the `patch delete` command: removes a patch file and its manifest
 * row atomically, refusing when a later patch imports a leaf owned by the
 * target.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename or ordinal number to delete
 * @param options - Command options
 */
export async function patchDeleteCommand(
  projectRoot: string,
  identifier: string,
  options: PatchDeleteOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch delete (dry run)' : 'FireForge patch delete');

  const { paths, manifest } = await requirePatchQueue(projectRoot, {
    missingDirMessage: 'Patches directory not found. No patches to delete.',
  });
  const target = requirePatchTarget(identifier, manifest.patches);

  // Build the full queue context once so we can scan each patch's newFiles
  // without re-parsing for the dependency check below. Hard refusal: an
  // import owned by a later patch that points at any of the target's
  // newly-created files is a dependency on the target.
  const baseCtx = await buildPatchQueueContext(paths.patches);
  const dependents = collectRemovalDependents(baseCtx, target, {
    noun: 'deletion',
    verb: 'delete',
  });
  warnDanglingStagedOwners(baseCtx, target, 'delete');

  // Under `patchPolicy.allowGaps: false` the removal can open a numeric gap
  // that every later lint and re-export refuses on. Naming it here, in
  // dry-run and at the prompt, puts the refill/compact choice in front of
  // the operator before the gap exists rather than after the next command.
  const gapNotices = describeProjectedGaps(await loadConfig(projectRoot), manifest, target);
  for (const line of gapNotices) {
    warn(line);
  }

  const conflicts = removalConflict(dependents, target);

  const summary: string[] = [
    `delete ${target.filename}  (category: ${target.category}, order: ${target.order})`,
    `description: ${target.description || '(none)'}`,
    `files currently claimed by this patch (${target.filesAffected.length}):`,
  ];
  for (const file of target.filesAffected) {
    summary.push(`  ${file}  → will become unmanaged`);
  }
  summary.push(...gapNotices);

  const decision = await confirmDestructive({
    operation: 'patch-delete',
    title: `Delete ${target.filename}`,
    summary,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });

  if (!proceedAfterDecision(decision, 'Delete cancelled')) return;

  // Proceed: remove under the patch directory lock so concurrent exports
  // cannot race us into the same manifest row. The history append lives
  // inside the same lock so two concurrent deletes cannot interleave history
  // records beyond what POSIX O_APPEND guarantees for a single record, and
  // so a crash between mutation and history write cannot leave a committed
  // mutation with no audit trail. A history append failure is warned but not
  // re-thrown: by that point the mutation has committed, and reporting
  // failure to the caller would mislead.
  await withPatchDirectoryLock(
    paths.patches,
    async () => {
      const current = await buildPatchQueueContext(paths.patches);
      // A changed body or manifest invalidates the dependency scan approved
      // before the prompt. Recheck all of its inputs while holding the lock.
      if (queueSnapshot(current) !== queueSnapshot(baseCtx)) {
        throw new GeneralError(
          'Patch queue changed while waiting for confirmation or the lock. Re-run patch delete to review the current dependencies.'
        );
      }
      await removePatchFileAndManifest(paths.patches, target.filename);
      await appendHistoryBestEffort(
        paths.patches,
        {
          operation: 'patch-delete',
          args: {
            filename: target.filename,
            order: target.order,
            filesAffected: target.filesAffected,
          },
          ...(options.yes === true ? { yes: true } : {}),
          ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
          result: 'ok',
        },
        `patch delete committed (${target.filename})`
      );
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch delete' }
  );

  info(`Deleted ${target.filename}.`);
  outro('Delete complete');
}

/**
 * Registers the `patch delete` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchDelete(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('delete <name>')
    .description('Delete a patch from the queue (destructive)')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option(
      '--force-unsafe',
      'Bypass the refusal when a later patch depends on this patch (last resort)'
    );
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        name: string,
        options: {
          dryRun?: boolean;
          yes?: boolean;
          forceUnsafe?: boolean;
          waitLock?: number | boolean;
        }
      ) => {
        await patchDeleteCommand(getProjectRoot(), name, pickDefined(options));
      }
    )
  );
}
