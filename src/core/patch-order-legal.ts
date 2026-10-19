// SPDX-License-Identifier: EUPL-1.2
/**
 * The earliest order a new patch can take after a given order, under the
 * queue's occupancy and `patchPolicy`.
 *
 * A refusal that says "export it as its own later patch" leaves the
 * operator to find a number that is free, inside the category's range, and
 * (with `allowGaps: false`) does not open a gap. Each wrong guess costs a
 * full export attempt. This answers it once, with the same policy
 * evaluation the export itself will run.
 */

import type { PatchesManifest, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { formatPatchOrder } from './patch-parse.js';
import { evaluatePatchPolicy, type PatchPolicyIssueCode } from './patch-policy.js';
import { reservedOrderSet } from './patch-retired.js';

/** Policy codes an order choice alone can trip. */
const ORDER_CODES: ReadonlySet<PatchPolicyIssueCode> = new Set([
  'order-collision',
  'category-range',
  'reserved-range',
  'numeric-gap',
]);

/** Upper bound on the search when no policy range bounds it. */
const UNBOUNDED_SEARCH = 1000;

const GAP_ORDERS_PATTERN = /numeric gap\(s\): (?<orders>[^.]+)\./;

/**
 * Order-related findings as comparable keys. A `numeric-gap` finding
 * becomes one key per missing order, so filling one gap of several reads as
 * removing a key rather than as a new, differently worded finding.
 */
function orderIssueKeys(
  config: Pick<FireForgeConfig, 'patchPolicy'>,
  manifest: PatchesManifest
): Set<string> {
  const keys = new Set<string>();
  for (const issue of evaluatePatchPolicy(config, manifest)) {
    if (!ORDER_CODES.has(issue.code)) continue;
    const gaps = issue.code === 'numeric-gap' ? GAP_ORDERS_PATTERN.exec(issue.message) : null;
    if (gaps?.groups?.['orders'] === undefined) {
      keys.add(`${issue.code}|${issue.message}`);
      continue;
    }
    for (const order of gaps.groups['orders'].split(',')) {
      keys.add(`numeric-gap|${issue.filename}|${order.trim()}`);
    }
  }
  return keys;
}

/**
 * Smallest order strictly greater than `after` that no patch occupies and
 * that adds no order-related `patchPolicy` finding (collision, category
 * range, reserved range, numeric gap) for a `category` patch. A retired
 * slot counts as free, since a patch may fill it; a reservation does not,
 * since it is held for its owner's export. Returns null when no such
 * order exists inside the category's configured ranges.
 *
 * @param config - Project config (only `patchPolicy` is read)
 * @param manifest - Current manifest
 * @param category - Category the new patch would carry
 * @param after - The order the new patch must come after
 */
export function earliestLegalOrderAfter(
  config: Pick<FireForgeConfig, 'patchPolicy'>,
  manifest: PatchesManifest,
  category: string,
  after: number
): number | null {
  const occupied = new Set([
    ...manifest.patches.map((patch) => patch.order),
    ...reservedOrderSet(manifest),
  ]);
  const ranges = config.patchPolicy?.ranges.filter((range) => range.category === category) ?? [];
  const limit =
    ranges.length > 0 ? Math.max(...ranges.map((range) => range.to)) : after + UNBOUNDED_SEARCH;
  const baseline = config.patchPolicy ? orderIssueKeys(config, manifest) : new Set<string>();

  for (let order = after + 1; order <= limit; order++) {
    if (occupied.has(order)) continue;
    if (!config.patchPolicy) return order;
    const probe: PatchMetadata = {
      filename: `${formatPatchOrder(order)}-${category}-probe.patch`,
      order,
      category,
      name: 'probe',
      description: 'probe',
      createdAt: '',
      sourceEsrVersion: '',
      filesAffected: [],
    };
    const projected: PatchesManifest = { ...manifest, patches: [...manifest.patches, probe] };
    const introduced = [...orderIssueKeys(config, projected)].filter((key) => !baseline.has(key));
    if (introduced.length === 0) return order;
  }
  return null;
}
