// SPDX-License-Identifier: EUPL-1.2
/**
 * Retired order slots: the placeholders `patch retire` leaves in
 * `patches.json#retired` so a patch can leave the queue without opening a
 * numeric gap or renumbering its successors.
 *
 * A slot is not a patch. It has no `.patch` file and no row in `patches`,
 * so everything that applies, exports, lints or rebases the queue walks past
 * it without knowing it exists. The one reader is the
 * `patchPolicy.allowGaps: false` gap check, which counts a retired order as
 * occupied. A patch that later takes the same order fills the slot, and
 * {@link carryRetiredSlots} drops it on that write, so the manifest never
 * holds a slot and a patch at one order.
 *
 * Reserved slots (`patch reserve`) follow the same rules: a placeholder for
 * an order a session has claimed but not exported yet, counted as occupied
 * by the gap check and filled (and dropped) by the export that lands on it.
 */

import type {
  PatchesManifest,
  PatchMetadata,
  PatchReservedSlot,
  PatchRetiredSlot,
} from '../types/commands/index.js';

/**
 * The retired slots of `current` that no patch in `patches` occupies, or
 * undefined when none remain. Every manifest write that rebuilds the
 * `patches` list routes the slots through here, so a slot survives the
 * rewrite and a filled one does not.
 *
 * @param current - Manifest the slots come from (null or slot-free: none)
 * @param patches - The rows the written manifest will hold
 */
export function carryRetiredSlots(
  current: Pick<PatchesManifest, 'retired'> | null | undefined,
  patches: readonly Pick<PatchMetadata, 'order'>[]
): PatchRetiredSlot[] | undefined {
  const slots = current?.retired;
  if (slots === undefined || slots.length === 0) return undefined;
  const occupied = new Set(patches.map((patch) => patch.order));
  const kept = slots
    .filter((slot) => !occupied.has(slot.order))
    .map((slot) => ({ ...slot }))
    .sort((a, b) => a.order - b.order);
  return kept.length > 0 ? kept : undefined;
}

/**
 * Reserved twin of {@link carryRetiredSlots}: the reservations of `current`
 * that no patch in `patches` has filled yet.
 *
 * @param current - Manifest the slots come from
 * @param patches - The rows the written manifest will hold
 */
export function carryReservedSlots(
  current: Pick<PatchesManifest, 'reserved'> | null | undefined,
  patches: readonly Pick<PatchMetadata, 'order'>[]
): PatchReservedSlot[] | undefined {
  const slots = current?.reserved;
  if (slots === undefined || slots.length === 0) return undefined;
  const occupied = new Set(patches.map((patch) => patch.order));
  const kept = slots
    .filter((slot) => !occupied.has(slot.order))
    .map((slot) => ({ ...slot }))
    .sort((a, b) => a.order - b.order);
  return kept.length > 0 ? kept : undefined;
}

/**
 * Builds a manifest from `patches` that keeps `current`'s unfilled retired
 * and reserved slots. Each key is omitted entirely when no slot remains, so
 * a queue that never retired or reserved anything writes the same JSON as
 * before.
 *
 * @param current - Manifest the slots come from
 * @param patches - The rows the written manifest will hold
 */
export function manifestWithRetiredSlots(
  current: Pick<PatchesManifest, 'retired' | 'reserved'> | null | undefined,
  patches: PatchMetadata[]
): PatchesManifest {
  const retired = carryRetiredSlots(current, patches);
  const reserved = carryReservedSlots(current, patches);
  return {
    version: 1,
    patches,
    ...(retired !== undefined ? { retired } : {}),
    ...(reserved !== undefined ? { reserved } : {}),
  };
}

/** The set of order numbers held by retired slots. */
export function retiredOrderSet(manifest: Pick<PatchesManifest, 'retired'>): Set<number> {
  return new Set((manifest.retired ?? []).map((slot) => slot.order));
}

/** The set of order numbers held by reserved slots. */
export function reservedOrderSet(manifest: Pick<PatchesManifest, 'reserved'>): Set<number> {
  return new Set((manifest.reserved ?? []).map((slot) => slot.order));
}

/**
 * The reservation at `order`, if any.
 *
 * @param manifest - Manifest to search (null: none)
 * @param order - Order number
 */
export function reservationAt(
  manifest: Pick<PatchesManifest, 'reserved'> | null | undefined,
  order: number
): PatchReservedSlot | undefined {
  return manifest?.reserved?.find((slot) => slot.order === order);
}
