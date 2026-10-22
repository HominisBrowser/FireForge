// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch reorder --shift <n> --from <order> [--through <order>]`
 * renumbers a run of patches up by `n` in one gap-checked transaction, so
 * an insert has room.
 *
 * Opening room for four inserts after 103 meant moving 104 to 128 up by
 * four. `patch rename --order` moves one patch, and under
 * `patchPolicy.allowGaps: false` every single step refused on the gap it
 * left, so the only way through was one `patch split --after` per insert.
 * The shift moves the whole run at once (the retired and reserved slots
 * inside it move with it), and under `allowGaps: false` records the orders
 * it opens as `patches.json#reserved` slots, so the queue stays valid and
 * the inserts that follow fill them.
 *
 * Same contract as `patch compact`: a projected policy check, a projected
 * cross-patch lint (reporting only what the shift itself adds), a
 * confirmation, and a commit under the patch-directory lock that refuses
 * if the plan changed while it waited.
 */

import { loadConfig } from '../../core/config.js';
import { confirmDestructive, type ConflictReport } from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import {
  buildPatchQueueContext,
  formatPatchLintIssue,
  lintPatchQueue,
} from '../../core/patch-lint.js';
import { computeProjectedLintRegressions } from '../../core/patch-lint-projection.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  loadPatchesManifestForWrite,
  type PatchRenameEntry,
  renumberPatchesInManifest,
  savePatchesManifest,
} from '../../core/patch-manifest.js';
import { formatPatchOrder } from '../../core/patch-parse.js';
import { applyRenameMapToManifest, enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type {
  PatchesManifest,
  PatchReorderOptions,
  PatchReservedSlot,
  PatchRetiredSlot,
} from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { resolveWaitLockSeconds } from '../../utils/options.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import {
  getSortedRenameEntries,
  renameMapsEqual,
  writeRenameMapFile,
} from '../patch-rename-map.js';
import { requirePatchQueue } from './patch-context.js';
import { projectReorder, rebuildFilenameForOrder } from './reorder-projection.js';

/** Owner label recorded on the reservations a shift opens. */
const SHIFT_RESERVATION_OWNER = 'patch reorder --shift';

/** A planned shift: the renames and the slot lists the manifest ends with. */
interface ShiftPlan {
  shift: number;
  from: number;
  through: number;
  renameMap: Map<string, PatchRenameEntry>;
  /** Retired slots after the shift (the ones inside the run moved with it). */
  retired: PatchRetiredSlot[];
  /** Reserved slots after the shift, the opened orders included. */
  reserved: PatchReservedSlot[];
  /** Orders the shift opened and reserved (empty unless `allowGaps: false`). */
  opened: number[];
}

/** What occupies an order: a patch, a retired slot or a reservation. */
function occupantAt(manifest: PatchesManifest, order: number): string | undefined {
  const patch = manifest.patches.find((entry) => entry.order === order);
  if (patch !== undefined) return patch.filename;
  const retired = manifest.retired?.find((slot) => slot.order === order);
  if (retired !== undefined) return `the retired slot of ${retired.filename}`;
  const reserved = manifest.reserved?.find((slot) => slot.order === order);
  if (reserved !== undefined) return `the reservation held by ${reserved.owner}`;
  return undefined;
}

/** The category of whatever occupies `order`. */
function categoryAt(manifest: PatchesManifest, order: number): string | undefined {
  return (
    manifest.patches.find((entry) => entry.order === order)?.category ??
    manifest.retired?.find((slot) => slot.order === order)?.category ??
    manifest.reserved?.find((slot) => slot.order === order)?.category
  );
}

/**
 * The last order of the run that starts at `from`: consecutive occupied
 * orders (patches and slots) of the first occupant's category.
 */
function defaultThrough(manifest: PatchesManifest, from: number): number {
  const category = categoryAt(manifest, from);
  let through = from;
  while (
    occupantAt(manifest, through + 1) !== undefined &&
    categoryAt(manifest, through + 1) === category
  ) {
    through++;
  }
  return through;
}

/**
 * Plans a shift against `manifest`, refusing a run with no patch, a
 * `--through` before `--from`, and a shift that lands on an occupied order
 * past the run.
 *
 * @param manifest - The queue
 * @param config - Project configuration (`patchPolicy.allowGaps`)
 * @param options - `shift`, `from` and optional `through`
 */
function planShift(
  manifest: PatchesManifest,
  config: FireForgeConfig,
  options: { shift: number; from: number; through?: number | undefined }
): ShiftPlan {
  const { shift, from } = options;
  if (occupantAt(manifest, from) === undefined) {
    throw new InvalidArgumentError(
      `No patch or slot holds order ${formatPatchOrder(from)}; --from names the first order of the run to shift.`,
      '--from'
    );
  }
  const through = options.through ?? defaultThrough(manifest, from);
  if (through < from) {
    throw new InvalidArgumentError(`--through ${through} is before --from ${from}.`, '--through');
  }
  const inRun = (order: number): boolean => order >= from && order <= through;
  const members = manifest.patches.filter((patch) => inRun(patch.order));
  if (members.length === 0) {
    throw new InvalidArgumentError(
      `No patch sits between orders ${formatPatchOrder(from)} and ${formatPatchOrder(through)}; nothing to shift.`,
      '--from'
    );
  }
  for (let order = through + 1; order <= through + shift; order++) {
    const occupant = occupantAt(manifest, order);
    if (occupant !== undefined) {
      throw new InvalidArgumentError(
        `--shift ${shift} would move the run ${formatPatchOrder(from)}-${formatPatchOrder(through)} ` +
          `onto order ${formatPatchOrder(order)}, which ${occupant} holds. Extend the run with ` +
          '--through, or shift by fewer orders.',
        '--shift'
      );
    }
  }

  const renameMap = new Map<string, PatchRenameEntry>();
  for (const patch of members) {
    const newOrder = patch.order + shift;
    renameMap.set(patch.filename, {
      newOrder,
      newFilename: rebuildFilenameForOrder(patch, newOrder),
    });
  }
  const moveSlot = <T extends { order: number }>(slot: T): T =>
    inRun(slot.order) ? { ...slot, order: slot.order + shift } : slot;
  const retired = (manifest.retired ?? []).map(moveSlot);
  const reserved = (manifest.reserved ?? []).map(moveSlot);

  // Every order below the shifted run's new start is free after the shift
  // (the collision check above saw to the ones past the old run), so under
  // `allowGaps: false` each one is held until an insert fills it.
  const opened: number[] = [];
  const category = categoryAt(manifest, from);
  if (config.patchPolicy?.allowGaps === false && category !== undefined) {
    const reservedAt = new Date().toISOString();
    for (let order = from; order < from + shift; order++) {
      opened.push(order);
      reserved.push({
        order,
        category,
        owner: SHIFT_RESERVATION_OWNER,
        reservedAt,
        reason: `opened by patch reorder --shift ${shift} --from ${from}`,
      });
    }
  }
  const byOrder = <T extends { order: number }>(a: T, b: T): number => a.order - b.order;
  return {
    shift,
    from,
    through,
    renameMap,
    retired: retired.sort(byOrder),
    reserved: reserved.sort(byOrder),
    opened,
  };
}

/** The manifest a shift leaves: renamed rows with the plan's slot lists. */
function projectShiftManifest(manifest: PatchesManifest, plan: ShiftPlan): PatchesManifest {
  const renamed = applyRenameMapToManifest(manifest, plan.renameMap);
  return {
    version: renamed.version,
    patches: renamed.patches,
    ...(plan.retired.length > 0 ? { retired: plan.retired } : {}),
    ...(plan.reserved.length > 0 ? { reserved: plan.reserved } : {}),
  };
}

/** True when two plans make the same renames and leave the same slot orders. */
function shiftPlansEqual(left: ShiftPlan, right: ShiftPlan): boolean {
  const orders = (slots: readonly { order: number }[]): string =>
    slots.map((slot) => slot.order).join(',');
  return (
    renameMapsEqual(left.renameMap, right.renameMap) &&
    orders(left.retired) === orders(right.retired) &&
    orders(left.reserved) === orders(right.reserved)
  );
}

/** Cross-patch lint errors the shift itself introduces. */
async function projectShiftLint(
  patchesDir: string,
  config: FireForgeConfig,
  renameMap: Map<string, PatchRenameEntry>
): Promise<ConflictReport | null> {
  const baseCtx = await buildPatchQueueContext(patchesDir, config);
  const isError = (issue: { severity: string }): boolean => issue.severity === 'error';
  const regressions = computeProjectedLintRegressions(
    lintPatchQueue(baseCtx).filter(isError),
    // The projection keeps the baseline's queue-wide lint settings, so the
    // two sides compare symmetric rule sets.
    lintPatchQueue({ ...baseCtx, ...projectReorder(baseCtx, renameMap) }).filter(isError)
  );
  return regressions.length === 0
    ? null
    : {
        reason: `shift would introduce ${regressions.length} cross-patch lint error(s)`,
        details: regressions.map(formatPatchLintIssue),
      };
}

/** Lines describing a plan, for the dry run and the confirmation prompt. */
function describeShift(manifest: PatchesManifest, plan: ShiftPlan): string[] {
  const lines = [
    `shift orders ${formatPatchOrder(plan.from)}-${formatPatchOrder(plan.through)} up by ${plan.shift}`,
    `${plan.renameMap.size} patch(es) would be renamed:`,
    ...getSortedRenameEntries(plan.renameMap).map(
      ([from, entry]) => `  ${from}  →  ${entry.newFilename}  (order ${entry.newOrder})`
    ),
  ];
  const inRun = (order: number): boolean => order >= plan.from && order <= plan.through;
  for (const slot of manifest.retired ?? []) {
    if (inRun(slot.order)) {
      lines.push(
        `retired slot ${formatPatchOrder(slot.order)} (${slot.filename}) moves to ${formatPatchOrder(slot.order + plan.shift)}`
      );
    }
  }
  for (const slot of manifest.reserved ?? []) {
    if (inRun(slot.order)) {
      lines.push(
        `reservation ${formatPatchOrder(slot.order)} (held by ${slot.owner}) moves to ` +
          `${formatPatchOrder(slot.order + plan.shift)}; tell its holder the new order`
      );
    }
  }
  if (plan.opened.length > 0) {
    lines.push(
      `opened orders ${plan.opened.map((order) => formatPatchOrder(order)).join(', ')} are ` +
        'reserved (patchPolicy.allowGaps: false); "fireforge export --order <n>" or ' +
        '"patch split --order <n>" fills them, "patch reserve <n> --release" drops one'
    );
  }
  return lines;
}

/**
 * Commits a confirmed shift under the patch-directory lock: re-plans
 * against the current manifest (refusing a changed plan), renumbers, then
 * writes the plan's slot lists. A failed slot write inverts the renumber.
 */
async function commitShift(
  patchesDir: string,
  config: FireForgeConfig,
  plan: ShiftPlan,
  options: PatchReorderOptions
): Promise<void> {
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const current = await loadPatchesManifest(patchesDir);
      if (!current) throw new GeneralError('Manifest disappeared while waiting for lock.');
      const currentPlan = planShift(current, config, {
        shift: plan.shift,
        from: plan.from,
        through: plan.through,
      });
      if (!shiftPlansEqual(plan, currentPlan)) {
        throw new GeneralError(
          'Patch queue changed while waiting for confirmation. Re-run reorder --shift to recompute the plan.'
        );
      }
      enforcePatchPolicy({
        config,
        manifest: projectShiftManifest(current, plan),
        command: 'patch reorder --shift',
        forceUnsafe: options.forceUnsafe === true,
      });

      await renumberPatchesInManifest(patchesDir, plan.renameMap);
      try {
        const renumbered = await loadPatchesManifestForWrite(patchesDir);
        if (!renumbered) throw new GeneralError('Manifest disappeared during reorder --shift.');
        delete renumbered.retired;
        delete renumbered.reserved;
        await savePatchesManifest(patchesDir, {
          ...renumbered,
          ...(plan.retired.length > 0 ? { retired: plan.retired } : {}),
          ...(plan.reserved.length > 0 ? { reserved: plan.reserved } : {}),
        });
      } catch (error: unknown) {
        const inverse = new Map(
          [...plan.renameMap].map(([oldFilename, entry]) => [
            entry.newFilename,
            { newFilename: oldFilename, newOrder: entry.newOrder - plan.shift },
          ])
        );
        try {
          await renumberPatchesInManifest(patchesDir, inverse);
          await savePatchesManifest(patchesDir, current);
        } catch (rollbackError: unknown) {
          warn(`Rollback warning: could not invert the shift: ${toError(rollbackError).message}`);
        }
        throw error;
      }

      await appendHistoryBestEffort(
        patchesDir,
        {
          operation: 'patch-reorder-shift',
          args: {
            shift: plan.shift,
            from: plan.from,
            through: plan.through,
            renames: getSortedRenameEntries(plan.renameMap).map(([from, entry]) => ({
              from,
              to: entry.newFilename,
              order: entry.newOrder,
            })),
            ...(plan.opened.length > 0 ? { reservedOpened: plan.opened } : {}),
          },
          ...(options.yes === true ? { yes: true } : {}),
          ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
          result: 'ok',
        },
        'patch reorder --shift committed'
      );
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch reorder' }
  );
}

/**
 * Runs `patch reorder --shift <n> --from <order> [--through <order>]`.
 *
 * @param projectRoot - Project root directory
 * @param options - Reorder options with `shift` and `from` set
 */
export async function patchReorderShiftCommand(
  projectRoot: string,
  options: PatchReorderOptions & { shift: number; from: number }
): Promise<void> {
  intro(
    options.dryRun ? 'FireForge patch reorder --shift (dry run)' : 'FireForge patch reorder --shift'
  );
  const config = await loadConfig(projectRoot);
  const { paths, manifest } = await requirePatchQueue(projectRoot);
  const plan = planShift(manifest, config, options);

  enforcePatchPolicy({
    config,
    manifest: projectShiftManifest(manifest, plan),
    command: 'patch reorder --shift',
    forceUnsafe: options.forceUnsafe === true,
  });
  const conflicts = await projectShiftLint(paths.patches, config, plan.renameMap);

  const decision = await confirmDestructive({
    operation: 'patch-reorder-shift',
    title: `Shift ${plan.renameMap.size} patch(es) from order ${formatPatchOrder(plan.from)} up by ${plan.shift}`,
    summary: describeShift(manifest, plan),
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
  if (!proceedAfterDecision(decision, 'Reorder cancelled')) return;

  await commitShift(paths.patches, config, plan, options);
  if (options.mapOut !== undefined) {
    const written = await writeRenameMapFile(options.mapOut, plan.renameMap);
    info(`Wrote the old-to-new filename map (${plan.renameMap.size} rename(s)) to ${written}`);
  }
  info(`Shifted ${plan.renameMap.size} patch(es) up by ${plan.shift}.`);
  outro('Reorder complete');
}
