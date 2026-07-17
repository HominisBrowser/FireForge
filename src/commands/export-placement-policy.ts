// SPDX-License-Identifier: EUPL-1.2
/**
 * Policy-aware checks for export placement plans.
 */

import { InvalidArgumentError } from '../errors/base.js';
import type { PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig, PatchPolicyReservedRange } from '../types/config.js';

export interface PlacementPolicyPlan {
  insertionOrder: number;
  renameMap: ReadonlyMap<string, { newFilename: string; newOrder: number }>;
}

function reservedRangeLabel(range: { from: number; to: number }): string {
  return `${String(range.from).padStart(3, '0')}-${String(range.to).padStart(3, '0')}`;
}

function findReservedRange(
  config: FireForgeConfig,
  order: number
): PatchPolicyReservedRange | null {
  return (
    config.patchPolicy?.reservedRanges?.find((range) => order >= range.from && order <= range.to) ??
    null
  );
}

/**
 * Scans downward from just below the reserved block for the first order
 * not occupied by an existing patch. Returns null when every positive
 * order below the block is taken.
 */
function firstFreeOrderBelowReservedRange(
  patches: readonly PatchMetadata[],
  range: PatchPolicyReservedRange
): number | null {
  const occupied = new Set(patches.map((patch) => patch.order));
  for (let order = range.from - 1; order >= 1; order--) {
    if (!occupied.has(order)) return order;
  }
  return null;
}

/**
 * Refuses positional placement plans whose renumber would touch a
 * `patchPolicy.reservedRanges` block — either by moving a patch INTO a
 * reserved range or by moving a patch that currently sits inside one.
 * Throws a single up-front error for the first reserved range hit (the
 * per-patch alternative surfaced one confusing finding per shifted
 * patch), suggesting the first free `--order` below the block when one
 * exists. Exact `--order` plans have an empty rename map and pass.
 */
export function assertPlacementAvoidsReservedRanges(
  plan: PlacementPolicyPlan,
  manifestPatches: readonly PatchMetadata[],
  config: FireForgeConfig | undefined
): void {
  if (config?.patchPolicy === undefined || plan.renameMap.size === 0) return;

  const byFilename = new Map(manifestPatches.map((patch) => [patch.filename, patch] as const));
  for (const [filename, rename] of plan.renameMap) {
    const oldOrder = byFilename.get(filename)?.order;
    const reserved =
      findReservedRange(config, rename.newOrder) ??
      (oldOrder !== undefined ? findReservedRange(config, oldOrder) : null);
    if (reserved === null) continue;

    const label = reservedRangeLabel(reserved);
    const freeOrder = firstFreeOrderBelowReservedRange(manifestPatches, reserved);
    if (freeOrder !== null) {
      throw new InvalidArgumentError(
        `Positional insert would renumber the reserved range ${label}; ` +
          `pass --order ${String(freeOrder).padStart(3, '0')} (first free order below the ` +
          'reserved block) to place the new patch without renumbering reserved patches.',
        'export placement'
      );
    }
    throw new InvalidArgumentError(
      `Positional insert would renumber the reserved range ${label}; ` +
        'no free order exists below the reserved block. Choose an unused --order outside ' +
        'the reserved range or adjust patchPolicy.reservedRanges.',
      'export placement'
    );
  }
}
