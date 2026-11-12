// SPDX-License-Identifier: EUPL-1.2
/**
 * Where a patch sits in the queue: the ordering half of `patchPolicy`, the
 * order a new patch gets, and moving a patch to an order or beside another.
 *
 * Without a policy any order is allowed. With one, every patch's order lies
 * in a range of its category, or in a reserved range that names its
 * filename; `requireDescription` and a `filenamePattern` apply to every
 * patch; with `allowGaps: false` a range has no unoccupied order between its
 * first and last occupied one. A retired slot counts as occupied: its
 * number is not given to a new patch, and it is no gap.
 *
 * Placing a patch at an occupied order moves the patch there and every
 * patch (and retired slot) in the consecutive run from that order up by
 * one, so nothing else is renumbered.
 */
import type { PatchPolicyConfig } from '../config/index.js';
import { ExitCode, FireForgeError, invariant } from '../kernel/errors.js';
import { categoryOf, type PatchEntry, patchFilename, type RetiredSlot } from './manifest.js';

/** Where {@link place} puts a patch: at an order, or right before or after a named patch. */
export type Placement = { order: number } | { before: string } | { after: string };

/** The rows placement reads and renumbers. */
export interface Slots {
  patches: Array<Pick<PatchEntry, 'order' | 'name'>>;
  retired: RetiredSlot[];
}

type Range = { from: number; to: number };

function within(range: Range, order: number): boolean {
  return order >= range.from && order <= range.to;
}

function label(range: Range): string {
  return `${range.from}-${range.to}`;
}

type ReservedRange = NonNullable<PatchPolicyConfig['reservedRanges']>[number];

function reservedAt(policy: PatchPolicyConfig, order: number): ReservedRange | undefined {
  return policy.reservedRanges?.find((range) => within(range, order));
}

function rangeProblem(policy: PatchPolicyConfig, entry: PatchEntry): string | undefined {
  const filename = patchFilename(entry);
  const reserved = reservedAt(policy, entry.order);
  if (reserved !== undefined) {
    return reserved.allowed.some((allowed) => allowed.filename === filename)
      ? undefined
      : `${filename} is in the reserved range ${label(reserved)}, which does not list it`;
  }
  const category = categoryOf(entry.name);
  const own = policy.ranges.filter((range) => range.category === category);
  if (own.some((range) => within(range, entry.order))) return undefined;
  const holder = policy.ranges.find((range) => within(range, entry.order));
  const expected = own.length === 0 ? 'no range' : own.map(label).join(', ');
  const actual =
    holder === undefined
      ? 'outside every range'
      : `in the ${holder.category} range ${label(holder)}`;
  return `${filename}: ${category} patches have ${expected}, and order ${entry.order} is ${actual}`;
}

function gapProblems(
  policy: PatchPolicyConfig,
  patches: readonly PatchEntry[],
  retired: readonly RetiredSlot[]
): string[] {
  const problems: string[] = [];
  for (const range of policy.ranges) {
    const occupied = new Set([
      ...patches
        .filter((entry) => categoryOf(entry.name) === range.category)
        .map((entry) => entry.order),
      ...retired.map((slot) => slot.order),
    ]);
    const orders = [...occupied]
      .filter((order) => within(range, order) && reservedAt(policy, order) === undefined)
      .sort((a, b) => a - b);
    const missing: number[] = [];
    for (let order = orders[0] ?? 0; order < (orders.at(-1) ?? 0); order++) {
      if (!occupied.has(order) && reservedAt(policy, order) === undefined) missing.push(order);
    }
    if (missing.length > 0) {
      problems.push(
        `the ${range.category} range ${label(range)} has gaps at ${missing.join(', ')} (patchPolicy.allowGaps is false)`
      );
    }
  }
  return problems;
}

/**
 * What the queue's rows break of the ordering policy.
 *
 * @param policy - `patchPolicy`, or undefined for none
 * @param patches - The rows
 * @param retired - The retired slots
 * @returns One sentence per problem; empty when the rows comply
 */
export function policyProblems(
  policy: PatchPolicyConfig | undefined,
  patches: readonly PatchEntry[],
  retired: readonly RetiredSlot[]
): string[] {
  if (policy === undefined) return [];
  const pattern =
    policy.filenamePattern === undefined ? undefined : new RegExp(policy.filenamePattern);
  const problems: string[] = [];
  for (const entry of patches) {
    const filename = patchFilename(entry);
    if (pattern !== undefined && !pattern.test(filename)) {
      problems.push(`${filename} does not match patchPolicy.filenamePattern`);
    }
    if (policy.requireDescription && entry.description.trim() === '') {
      problems.push(`${filename} has no description (patchPolicy.requireDescription)`);
    }
    const range = rangeProblem(policy, entry);
    if (range !== undefined) problems.push(range);
  }
  return policy.allowGaps ? problems : [...problems, ...gapProblems(policy, patches, retired)];
}

function occupiedOrders(slots: Slots, except?: string): Set<number> {
  return new Set([
    ...slots.patches.filter((row) => row.name !== except).map((row) => row.order),
    ...slots.retired.map((slot) => slot.order),
  ]);
}

/**
 * The order a new patch of a category gets: after the highest occupied
 * order, inside the category's ranges when a policy sets them.
 *
 * @param policy - `patchPolicy`, or undefined for none
 * @param slots - The queue's rows and retired slots
 * @param category - The new patch's category
 * @throws `queue-category-unknown` or `queue-range-full` (exit code 6)
 */
export function nextOrder(
  policy: PatchPolicyConfig | undefined,
  slots: Slots,
  category: string
): number {
  const occupied = occupiedOrders(slots);
  if (policy === undefined) return Math.max(0, ...occupied) + 1;
  const ranges = policy.ranges
    .filter((range) => range.category === category)
    .sort((a, b) => a.from - b.from);
  if (ranges.length === 0) {
    throw new FireForgeError(
      'queue-category-unknown',
      `patchPolicy has no range for the category "${category}".`,
      {
        exitCode: ExitCode.PATCH_ERROR,
        hint: `Name the patch with one of the configured categories: ${[...new Set(policy.ranges.map((range) => range.category))].join(', ')}.`,
      }
    );
  }
  const inRanges = [...occupied].filter((order) => ranges.some((range) => within(range, order)));
  const start = inRanges.length === 0 ? 0 : Math.max(...inRanges) + 1;
  for (const range of ranges) {
    for (let order = Math.max(start, range.from); order <= range.to; order++) {
      if (!occupied.has(order) && reservedAt(policy, order) === undefined) return order;
    }
  }
  throw new FireForgeError(
    'queue-range-full',
    `The ${category} range ${ranges.map(label).join(', ')} has no free order after its last patch.`,
    {
      exitCode: ExitCode.PATCH_ERROR,
      hint: 'Run "fireforge patch compact", or place the patch with --order, --before or --after.',
    }
  );
}

/** Moves the consecutive run of occupied orders starting at `from` up by one. */
function shiftRun(slots: Slots, from: number, except: string): void {
  const occupied = occupiedOrders(slots, except);
  let end = from;
  while (occupied.has(end)) end++;
  for (const row of slots.patches) {
    if (row.name !== except && row.order >= from && row.order < end) row.order += 1;
  }
  for (const slot of slots.retired) {
    if (slot.order >= from && slot.order < end) slot.order += 1;
  }
}

function anchor(slots: Slots, name: string, moving: string): Pick<PatchEntry, 'order' | 'name'> {
  const row = slots.patches.find((candidate) => candidate.name === name);
  if (row === undefined || name === moving) {
    throw new FireForgeError(
      'invalid-argument',
      name === moving
        ? `A patch cannot be placed beside itself (${name}).`
        : `No patch is named ${name}.`,
      { exitCode: ExitCode.INVALID_ARGUMENT }
    );
  }
  return row;
}

/**
 * Gives the row named `name` its place: the order asked for, or the free
 * order right before or after another patch. An occupied order is made free
 * by moving the run of orders above it up by one; an explicit order that
 * a retired slot holds takes the slot over.
 *
 * @param slots - The rows and retired slots, edited in place
 * @param name - The row to place (already among `slots.patches`)
 * @param placement - Where
 * @returns The row's new order
 */
export function place(slots: Slots, name: string, placement: Placement): number {
  const row = slots.patches.find((candidate) => candidate.name === name);
  invariant(row !== undefined, () => `place: ${name} is not among the rows`);
  const occupied = occupiedOrders(slots, name);
  let order: number;
  if ('order' in placement) {
    order = placement.order;
    const retired = slots.retired.findIndex((slot) => slot.order === order);
    const held = slots.patches.some((other) => other.name !== name && other.order === order);
    if (retired !== -1 && !held) slots.retired.splice(retired, 1);
    else if (held) shiftRun(slots, order, name);
  } else if ('before' in placement) {
    const target = anchor(slots, placement.before, name);
    order = target.order > 1 && !occupied.has(target.order - 1) ? target.order - 1 : target.order;
    if (order === target.order) shiftRun(slots, order, name);
  } else {
    const target = anchor(slots, placement.after, name);
    order = target.order + 1;
    if (occupied.has(order)) shiftRun(slots, order, name);
  }
  row.order = order;
  return order;
}

/**
 * Closes the gaps in the queue's orders, keeping their sequence. Without a
 * policy the queue is numbered from 1; with one, each category range is
 * numbered from its first patch, around reserved ranges and around patches
 * of other categories that sit in it. Retired slots in renumbered orders are
 * dropped.
 *
 * @param policy - `patchPolicy`, or undefined for none
 * @param slots - The rows and retired slots, edited in place
 */
export function compactOrders(policy: PatchPolicyConfig | undefined, slots: Slots): void {
  const sorted = [...slots.patches].sort((a, b) => a.order - b.order);
  if (policy === undefined) {
    for (const [index, row] of sorted.entries()) row.order = index + 1;
    slots.retired.length = 0;
    return;
  }
  for (const range of policy.ranges) {
    const members = sorted.filter(
      (row) =>
        categoryOf(row.name) === range.category &&
        within(range, row.order) &&
        reservedAt(policy, row.order) === undefined
    );
    const first = members[0];
    if (first === undefined) continue;
    const others = new Set(sorted.filter((row) => !members.includes(row)).map((row) => row.order));
    let order = first.order;
    for (const row of members) {
      while (others.has(order) || reservedAt(policy, order) !== undefined) order++;
      row.order = order++;
    }
    slots.retired = slots.retired.filter((slot) => !within(range, slot.order));
  }
}
