// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch reorder <name> --to <N> | --before <name> | --after <name>`
 *
 * Renames the target .patch file and rewrites manifest rows so the target
 * moves to the requested ordinal slot. Any subsequent patches are
 * renumbered to make room. Pre-flights the projected order through
 * `lintPatchQueue` so reorders that would introduce a forward-import fail
 * before any bytes move.
 */

import { Command, Option } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import {
  appendHistory,
  confirmDestructive,
  type ConflictReport,
  type HistoryEntry,
} from '../../core/destructive.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import {
  buildPatchQueueContext,
  lintPatchQueue,
  type PatchQueueContext,
  type PatchQueueEntry,
} from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  type PatchRenameEntry,
  renumberPatchesInManifest,
  resolvePatchIdentifier,
} from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchMetadata, PatchReorderOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { pickDefined } from '../../utils/options.js';
import { parsePositiveIntegerFlag } from '../../utils/validation.js';

/** Zero-pads an ordinal number to the given width. */
export function padOrder(value: number, width: number): string {
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
 * Computes a rename map that moves `target` to `destinationOrder` with a
 * minimal shift: only the contiguous run of patches whose current order
 * blocks the destination slot is renumbered, so intentional gaps left by
 * prior `patch delete` calls survive the reorder.
 *
 * Algorithm: remove target from the sorted list, then cascade: if any
 * patch sits at the destination order, bump it to order+1; if that
 * collides with the next patch, bump that one too; continue until a free
 * slot is reached. The direction is symmetric — moving a patch earlier
 * and moving it later both reduce to "find a free slot at destination by
 * shifting the contiguous conflicting run upward".
 */
function computeRenameMap(
  manifestPatches: PatchMetadata[],
  target: PatchMetadata,
  destinationOrder: number
): Map<string, PatchRenameEntry> {
  const renames = new Map<string, PatchRenameEntry>();
  if (destinationOrder === target.order) return renames;

  const sorted = [...manifestPatches].sort((a, b) => a.order - b.order);
  const withoutTarget = sorted.filter((p) => p.filename !== target.filename);

  // Clamp destination into the meaningful range. `--to 0` snaps to
  // minOrder, `--to 99` to maxOrder+1 (append past the tail).
  const minOrder = Math.min(...sorted.map((p) => p.order));
  const maxOrderAfterRemoval =
    withoutTarget.length > 0 ? Math.max(...withoutTarget.map((p) => p.order)) : minOrder;
  const clampedDest = Math.max(minOrder, Math.min(destinationOrder, maxOrderAfterRemoval + 1));

  if (clampedDest === target.order) return renames;

  // Build a mutable order-for-each map so cascading bumps compose. Keys are
  // filenames; values start as current order and get rewritten as bumps
  // propagate. Only patches whose value changes end up in the rename map.
  const currentOrder = new Map<string, number>();
  for (const patch of withoutTarget) currentOrder.set(patch.filename, patch.order);

  // Cascade from the destination: while any surviving patch occupies the
  // slot we want, bump it to slot+1 and advance. Patches are processed in
  // ascending order so each bump's collision (if any) is with the immediate
  // successor in the sort — no back-tracking needed.
  let slot = clampedDest;
  for (const patch of withoutTarget) {
    const order = currentOrder.get(patch.filename);
    if (order === undefined) continue;
    if (order < slot) continue;
    if (order > slot) break;
    // Collision at `slot`: bump this patch to slot+1 and continue scanning,
    // because slot+1 may also be occupied by the next patch in sequence.
    currentOrder.set(patch.filename, slot + 1);
    slot = slot + 1;
  }

  for (const patch of withoutTarget) {
    const newOrder = currentOrder.get(patch.filename);
    if (newOrder === undefined || newOrder === patch.order) continue;
    renames.set(patch.filename, {
      newOrder,
      newFilename: rebuildFilenameForOrder(patch, newOrder),
    });
  }

  renames.set(target.filename, {
    newOrder: clampedDest,
    newFilename: rebuildFilenameForOrder(target, clampedDest),
  });

  return renames;
}

function getSortedRenameEntries(
  renameMap: Map<string, PatchRenameEntry>
): Array<[string, PatchRenameEntry]> {
  return Array.from(renameMap.entries()).sort((a, b) => a[1].newOrder - b[1].newOrder);
}

function renameMapsEqual(
  left: Map<string, PatchRenameEntry>,
  right: Map<string, PatchRenameEntry>
): boolean {
  const leftEntries = getSortedRenameEntries(left);
  const rightEntries = getSortedRenameEntries(right);
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  return leftEntries.every(([leftFilename, leftEntry], index) => {
    const rightTuple = rightEntries[index];
    if (!rightTuple) return false;
    const [rightFilename, rightEntry] = rightTuple;
    return (
      leftFilename === rightFilename &&
      leftEntry.newFilename === rightEntry.newFilename &&
      leftEntry.newOrder === rightEntry.newOrder
    );
  });
}

/**
 * Applies a rename map to a {@link PatchQueueContext} so cross-patch lint
 * can run against the projected state without touching disk.
 */
function projectReorder(
  base: PatchQueueContext,
  renameMap: Map<string, PatchRenameEntry>
): PatchQueueContext {
  const projectedEntries: PatchQueueEntry[] = base.entries.map((entry) => {
    const rename = renameMap.get(entry.filename);
    if (!rename) return entry;
    return {
      ...entry,
      filename: rename.newFilename,
      order: rename.newOrder,
    };
  });
  projectedEntries.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
  return { entries: projectedEntries };
}

/**
 * Resolves `--to <N>`, `--before <anchor>`, and `--after <anchor>` into a
 * concrete destination order and, for the anchor variants, the anchor
 * filename the reorder should position against. Extracted from
 * {@link patchReorderCommand} so the command body stays inside the
 * project's per-function line budget.
 */
function resolveDestination(
  target: PatchMetadata,
  manifestPatches: PatchMetadata[],
  options: PatchReorderOptions
): { destinationOrder: number; anchorFilename: string | undefined } {
  if (options.to !== undefined) {
    // Defense-in-depth: the argParser should have rejected non-positive
    // integers, but the function is reachable from tests that may pass
    // `{ to: NaN }` directly.
    if (!Number.isInteger(options.to) || options.to <= 0) {
      throw new InvalidArgumentError(
        `--to must be a positive integer, got ${String(options.to)}.`,
        '--to'
      );
    }
    return { destinationOrder: options.to, anchorFilename: undefined };
  }

  if (options.before !== undefined) {
    const anchor = resolvePatchIdentifier(options.before, manifestPatches);
    if (!anchor) {
      throw new InvalidArgumentError(`--before anchor "${options.before}" not found.`, '--before');
    }
    // Reject self-reference. `--before <target>` resolves to the target's
    // current order, so computeRenameMap would take its no-op branch — but
    // that masks a user-facing typo or scripted mistake instead of
    // surfacing it. The symmetric `--after` case is worse (mutates the
    // queue), so both reject for consistency.
    if (anchor.filename === target.filename) {
      throw new InvalidArgumentError(
        `Cannot reorder patch "${target.filename}" relative to itself.`,
        '--before'
      );
    }
    return { destinationOrder: anchor.order, anchorFilename: anchor.filename };
  }

  const afterId = options.after;
  if (afterId === undefined) {
    throw new InvalidArgumentError('Reached --after resolver with no value set.', '--after');
  }
  const anchor = resolvePatchIdentifier(afterId, manifestPatches);
  if (!anchor) {
    throw new InvalidArgumentError(`--after anchor "${afterId}" not found.`, '--after');
  }
  // See the --before branch above: self-reference is a logical
  // contradiction. In the --after case, the previous `anchor.order + 1`
  // bypassed computeRenameMap's no-op short-circuit and silently
  // renumbered the target and every patch after it.
  if (anchor.filename === target.filename) {
    throw new InvalidArgumentError(
      `Cannot reorder patch "${target.filename}" relative to itself.`,
      '--after'
    );
  }
  return { destinationOrder: anchor.order + 1, anchorFilename: anchor.filename };
}

async function commitReorderPlan(
  patchesDir: string,
  target: PatchMetadata,
  renameMap: Map<string, PatchRenameEntry>,
  anchorFilename: string | undefined,
  options: PatchReorderOptions,
  buildHistoryEntry: (finalRenameMap: Map<string, PatchRenameEntry>) => HistoryEntry
): Promise<void> {
  await withPatchDirectoryLock(patchesDir, async () => {
    const currentManifest = await loadPatchesManifest(patchesDir);
    if (!currentManifest || currentManifest.patches.length === 0) {
      throw new GeneralError('Patch queue changed while waiting for confirmation. Re-run reorder.');
    }

    const currentTarget = currentManifest.patches.find((p) => p.filename === target.filename);
    if (!currentTarget) {
      throw new GeneralError(
        `Patch queue changed while waiting for confirmation. ${target.filename} no longer exists; re-run reorder.`
      );
    }

    let currentDestinationOrder: number;
    if (options.to !== undefined) {
      currentDestinationOrder = options.to;
    } else if (options.before !== undefined) {
      const currentAnchor = currentManifest.patches.find((p) => p.filename === anchorFilename);
      if (!currentAnchor) {
        throw new GeneralError(
          'Patch queue changed while waiting for confirmation. The reorder anchor moved or disappeared; re-run reorder.'
        );
      }
      currentDestinationOrder = currentAnchor.order;
    } else {
      const currentAnchor = currentManifest.patches.find((p) => p.filename === anchorFilename);
      if (!currentAnchor) {
        throw new GeneralError(
          'Patch queue changed while waiting for confirmation. The reorder anchor moved or disappeared; re-run reorder.'
        );
      }
      currentDestinationOrder = currentAnchor.order + 1;
    }

    const currentRenameMap = computeRenameMap(
      currentManifest.patches,
      currentTarget,
      currentDestinationOrder
    );
    if (!renameMapsEqual(renameMap, currentRenameMap)) {
      throw new GeneralError(
        'Patch queue changed while waiting for confirmation. Re-run reorder to recompute the rename plan.'
      );
    }

    const currentProjected = projectReorder(
      await buildPatchQueueContext(patchesDir),
      currentRenameMap
    );
    const currentConflicts = lintPatchQueue(currentProjected).filter((i) => i.severity === 'error');
    if (currentConflicts.length > 0 && options.forceUnsafe !== true) {
      throw new InvalidArgumentError(
        `Refusing to run patch reorder: reorder would introduce ${currentConflicts.length} cross-patch lint error(s). Pass --force-unsafe to override.`,
        '--force-unsafe'
      );
    }

    await renumberPatchesInManifest(patchesDir, currentRenameMap);

    // Append the history record inside the lock so two concurrent
    // reorders cannot interleave mutation and history writes, and so a
    // crash between the rename and the history write cannot orphan a
    // committed reorder with no audit trail. If the append itself
    // fails (disk full, permissions), we warn but do not re-throw:
    // the mutation has already succeeded and is not reversible, so
    // surfacing the history failure as a command failure would
    // mislead the caller.
    try {
      await appendHistory(patchesDir, buildHistoryEntry(currentRenameMap));
    } catch (historyError: unknown) {
      warn(
        `History log append failed after patch reorder committed: ${toError(historyError).message}`
      );
    }
  });
}

/**
 * Runs the `patch reorder` command: computes a rename map moving the
 * target patch to the requested slot, projects the new order through
 * cross-patch lint, confirms, and then renames under the patch directory
 * lock.
 *
 * @param projectRoot - Project root directory
 * @param identifier - Patch filename or ordinal number to move
 * @param options - Command options (mutually exclusive --to/--before/--after)
 */
export async function patchReorderCommand(
  projectRoot: string,
  identifier: string,
  options: PatchReorderOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch reorder (dry run)' : 'FireForge patch reorder');

  const specifiedTargets = [
    options.to !== undefined,
    options.before !== undefined,
    options.after !== undefined,
  ].filter(Boolean).length;
  if (specifiedTargets === 0) {
    throw new InvalidArgumentError(
      'Specify --to <N>, --before <name>, or --after <name>.',
      'patch reorder'
    );
  }
  if (specifiedTargets > 1) {
    throw new InvalidArgumentError(
      '--to, --before, and --after are mutually exclusive.',
      'patch reorder'
    );
  }

  const paths = getProjectPaths(projectRoot);
  if (!(await pathExists(paths.patches))) {
    throw new GeneralError('Patches directory not found.');
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }

  const target = resolvePatchIdentifier(identifier, manifest.patches);
  if (!target) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(identifier, manifest.patches),
      identifier
    );
  }

  const { destinationOrder, anchorFilename } = resolveDestination(
    target,
    manifest.patches,
    options
  );

  const renameMap = computeRenameMap(manifest.patches, target, destinationOrder);
  if (renameMap.size === 0) {
    info('Target is already at the requested position. Nothing to do.');
    outro('Reorder complete (no-op)');
    return;
  }

  // Project the reorder through cross-patch lint. Forward-import violations
  // that are introduced *by* the reorder become hard refusals.
  const baseCtx = await buildPatchQueueContext(paths.patches);
  const projected = projectReorder(baseCtx, renameMap);
  const projectedIssues = lintPatchQueue(projected);
  const errorIssues = projectedIssues.filter((i) => i.severity === 'error');

  const conflicts: ConflictReport | null =
    errorIssues.length > 0
      ? {
          reason: `reorder would introduce ${errorIssues.length} cross-patch lint error(s)`,
          details: errorIssues.map((i) => `[${i.check}] ${i.file}: ${i.message}`),
        }
      : null;

  const renameEntries = getSortedRenameEntries(renameMap);
  const targetRename = renameMap.get(target.filename);
  if (!targetRename) {
    throw new GeneralError('Reorder plan did not include the target patch.');
  }
  const actualDestinationOrder = targetRename.newOrder;

  const summary: string[] = [
    `move ${target.filename}  →  order ${actualDestinationOrder}`,
    `${renameMap.size} patch(es) would be renamed:`,
  ];
  for (const [oldFilename, entry] of renameEntries) {
    summary.push(`  ${oldFilename}  →  ${entry.newFilename}  (order ${entry.newOrder})`);
  }

  const decision = await confirmDestructive({
    operation: 'patch-reorder',
    title: `Reorder ${target.filename} to position ${actualDestinationOrder}`,
    summary,
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });

  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'cancelled') {
    outro('Reorder cancelled');
    return;
  }

  // The history entry is built inside commitReorderPlan (still under the
  // lock) from the *final* rename map, not the pre-confirmation one, so
  // the destinationOrder and renames mirror what actually landed on disk.
  const buildHistoryEntry = (finalRenameMap: Map<string, PatchRenameEntry>): HistoryEntry => {
    const finalEntries = getSortedRenameEntries(finalRenameMap);
    const finalTarget = finalRenameMap.get(target.filename);
    return {
      operation: 'patch-reorder',
      args: {
        target: target.filename,
        destinationOrder: finalTarget?.newOrder ?? actualDestinationOrder,
        renames: finalEntries.map(([from, entry]) => ({
          from,
          to: entry.newFilename,
          order: entry.newOrder,
        })),
      },
      ...(options.yes === true ? { yes: true } : {}),
      ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
      result: 'ok',
    };
  };

  await commitReorderPlan(
    paths.patches,
    target,
    renameMap,
    anchorFilename,
    options,
    buildHistoryEntry
  );

  info(`Reordered ${renameMap.size} patch(es).`);
  outro('Reorder complete');
}

/**
 * Registers the `patch reorder` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchReorder(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  parent
    .command('reorder <name>')
    .description('Move a patch to a different position in the queue (destructive)')
    .addOption(
      new Option('--to <order>', 'Destination ordinal').argParser((v) =>
        parsePositiveIntegerFlag('--to', v)
      )
    )
    .option('--before <anchor>', 'Place the patch immediately before <anchor>')
    .option('--after <anchor>', 'Place the patch immediately after <anchor>')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass the refusal when the projected order introduces a lint error')
    .action(
      withErrorHandling(
        async (
          name: string,
          options: {
            to?: number;
            before?: string;
            after?: string;
            dryRun?: boolean;
            yes?: boolean;
            forceUnsafe?: boolean;
          }
        ) => {
          await patchReorderCommand(getProjectRoot(), name, pickDefined(options));
        }
      )
    );
}
