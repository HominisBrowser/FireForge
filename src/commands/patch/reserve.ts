// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch reserve <order>`: holds an order number for a patch a
 * session has agreed to export but has not exported yet.
 *
 * The case it exists for: under `patchPolicy.allowGaps: false`, a session
 * cannot `export --order 571` while a peer has claimed 569 and 570 but not
 * exported them, because the unfilled orders read as a gap. A reservation
 * is a placeholder in `patches.json#reserved` that the gap check counts as
 * occupied and the earliest-legal-order search counts as taken. The export
 * that lands on the order fills it (see `core/patch-retired.ts`), and
 * `--release` drops a reservation whose patch will not come.
 *
 * Metadata-only: no `.patch` file is written and no row is added, so
 * apply, lint and rebase never see a reservation.
 */

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { loadPatchesManifestForWrite, savePatchesManifest } from '../../core/patch-manifest.js';
import { formatPatchOrder } from '../../core/patch-parse.js';
import {
  categoryRangeForOrder,
  categoryRangeLabel,
  isCategoryAllowedByConfig,
} from '../../core/patch-policy.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type {
  PatchesManifest,
  PatchReservedSlot,
  PatchReserveOptions,
} from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { info, intro, outro } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { parsePositiveIntegerFlag } from '../../utils/validation.js';

/**
 * Refuses a reservation the manifest or the policy cannot hold: an order a
 * patch, a retired slot or another reservation already takes, or one
 * outside the category's configured ranges.
 */
function assertReservable(
  manifest: PatchesManifest,
  config: FireForgeConfig,
  order: number,
  category: string
): void {
  const label = formatPatchOrder(order);
  const patch = manifest.patches.find((entry) => entry.order === order);
  if (patch !== undefined) {
    throw new InvalidArgumentError(`Order ${label} is taken by ${patch.filename}.`, '<order>');
  }
  if ((manifest.retired ?? []).some((slot) => slot.order === order)) {
    throw new InvalidArgumentError(
      `Order ${label} is a retired slot; "fireforge export --order ${label}" fills it without a reservation.`,
      '<order>'
    );
  }
  const held = manifest.reserved?.find((slot) => slot.order === order);
  if (held !== undefined) {
    throw new InvalidArgumentError(
      `Order ${label} is already reserved by ${held.owner} (since ${held.reservedAt}).`,
      '<order>'
    );
  }
  const policy = config.patchPolicy;
  if (policy !== undefined && categoryRangeForOrder(policy, category, order) === null) {
    throw new InvalidArgumentError(
      `Order ${label} is outside the ${category} range (${categoryRangeLabel(policy.ranges, category)}).`,
      '<order>'
    );
  }
}

/**
 * Runs the `patch reserve` command.
 *
 * @param projectRoot - Project root directory
 * @param order - Order number to reserve or release
 * @param options - Command options
 */
export async function patchReserveCommand(
  projectRoot: string,
  order: number,
  options: PatchReserveOptions = {}
): Promise<void> {
  const releasing = options.release === true;
  const verb = releasing ? 'release' : 'reserve';
  intro(options.dryRun ? `FireForge patch ${verb} (dry run)` : `FireForge patch ${verb}`);

  const config = await loadConfig(projectRoot);
  const label = formatPatchOrder(order);
  let category: string | undefined;
  let owner: string | undefined;
  if (!releasing) {
    category = options.category;
    owner = options.owner?.trim();
    if (category === undefined || owner === undefined || owner === '') {
      throw new InvalidArgumentError(
        'patch reserve requires --category and --owner (or --release to drop a reservation).',
        [category === undefined ? '--category' : '', owner ? '' : '--owner']
          .filter(Boolean)
          .join(', ')
      );
    }
    if (!isCategoryAllowedByConfig(config, category)) {
      throw new InvalidArgumentError(`Unknown patch category "${category}".`, '--category');
    }
  } else if (options.category !== undefined || options.owner !== undefined) {
    throw new InvalidArgumentError(
      '--release takes only the order; --category and --owner apply when reserving.',
      '--release'
    );
  }

  const { patches: patchesDir } = getProjectPaths(projectRoot);
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const manifest = (await loadPatchesManifestForWrite(patchesDir)) ?? {
        version: 1 as const,
        patches: [],
      };
      const reserved = manifest.reserved ?? [];
      let slot: PatchReservedSlot;
      let next: PatchReservedSlot[];
      if (releasing) {
        const held = reserved.find((entry) => entry.order === order);
        if (held === undefined) {
          throw new InvalidArgumentError(`Order ${label} is not reserved.`, '<order>');
        }
        slot = held;
        next = reserved.filter((entry) => entry.order !== order);
      } else {
        assertReservable(manifest, config, order, category as string);
        slot = {
          order,
          category: category as string,
          owner: owner as string,
          reservedAt: new Date().toISOString(),
          ...(options.reason !== undefined ? { reason: options.reason } : {}),
        };
        next = [...reserved, slot].sort((a, b) => a.order - b.order);
      }

      const summary = releasing
        ? `release order ${label} (reserved by ${slot.owner})`
        : `reserve order ${label} for ${slot.owner} (category: ${slot.category})`;
      if (options.dryRun === true) {
        info(`[dry-run] ${summary}`);
        return;
      }

      if (next.length > 0) manifest.reserved = next;
      else delete manifest.reserved;
      await savePatchesManifest(patchesDir, manifest);
      await appendHistoryBestEffort(
        patchesDir,
        {
          operation: releasing ? 'patch-reserve-release' : 'patch-reserve',
          args: { ...slot },
          result: 'ok',
        },
        `patch ${verb} committed (${label})`
      );
      info(
        releasing
          ? `Released order ${label}.`
          : `Reserved order ${label} for ${slot.owner}; "fireforge export --order ${label}" fills it.`
      );
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: `patch ${verb}` }
  );

  outro(options.dryRun ? 'Dry run complete — no changes made' : `Patch ${verb} complete`);
}

/**
 * Registers the `patch reserve` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchReserve(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('reserve <order>')
    .description(
      'Hold an order number for a patch not exported yet, so patchPolicy.allowGaps: false ' +
        'sees no gap; the export that takes the order fills it (metadata only)'
    )
    .option('--category <category>', 'Category the reserved patch will carry')
    .option('--owner <label>', 'Who holds the reservation (a session label or planned filename)')
    .option('--reason <text>', 'Rationale recorded on the reserved slot')
    .option('--release', 'Drop the reservation at <order> instead of creating one')
    .option('--dry-run', 'Show what would change without writing');
  addWaitLockOption(command).action(
    withErrorHandling(async (rawOrder: string, options: PatchReserveOptions) => {
      await patchReserveCommand(
        getProjectRoot(),
        parsePositiveIntegerFlag('<order>', rawOrder),
        pickDefined(options)
      );
    })
  );
}
