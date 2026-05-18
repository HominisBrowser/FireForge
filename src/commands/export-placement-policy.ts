// SPDX-License-Identifier: EUPL-1.2
/**
 * Policy-aware checks for export placement plans.
 */

import { InvalidArgumentError } from '../errors/base.js';
import type { PatchCategory, PatchMetadata } from '../types/commands/index.js';
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

function suggestSparseOrder(
  config: FireForgeConfig,
  patches: readonly PatchMetadata[],
  category: PatchCategory,
  insertionOrder: number
): number | null {
  const ranges = (config.patchPolicy?.ranges ?? [])
    .filter((range) => range.category === category)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const occupied = new Set(patches.map((patch) => patch.order));

  for (const range of ranges) {
    for (let order = Math.max(insertionOrder, range.from); order <= range.to; order++) {
      if (!occupied.has(order) && findReservedRange(config, order) === null) return order;
    }
  }

  for (const range of ranges) {
    for (let order = range.from; order <= range.to; order++) {
      if (!occupied.has(order) && findReservedRange(config, order) === null) return order;
    }
  }

  return null;
}

/** Refuses positional export plans that would renumber exact reserved patches. */
export function assertPlacementPreservesReservedRanges(
  plan: PlacementPolicyPlan,
  manifestPatches: readonly PatchMetadata[],
  config: FireForgeConfig | undefined,
  category: PatchCategory
): void {
  if (config?.patchPolicy === undefined || plan.renameMap.size === 0) return;

  const byFilename = new Map(manifestPatches.map((patch) => [patch.filename, patch] as const));
  for (const [filename, rename] of plan.renameMap) {
    const patch = byFilename.get(filename);
    if (!patch) continue;
    const reserved = findReservedRange(config, patch.order);
    if (reserved === null) continue;

    const suggestion = suggestSparseOrder(config, manifestPatches, category, plan.insertionOrder);
    const suggestionText =
      suggestion !== null
        ? ` Use --order ${String(suggestion).padStart(3, '0')} to create the new patch in an unused ${category} slot without renumbering reserved patches.`
        : ` Choose an unused order in the ${category} policy range or adjust patchPolicy.`;
    throw new InvalidArgumentError(
      `Positional export would renumber reserved patch ${patch.filename} ` +
        `from ${String(patch.order).padStart(3, '0')} to ${rename.newFilename} ` +
        `(reserved range ${reservedRangeLabel(reserved)}).` +
        suggestionText,
      'export placement'
    );
  }
}
