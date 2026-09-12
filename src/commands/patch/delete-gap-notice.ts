// SPDX-License-Identifier: EUPL-1.2
/**
 * Projects the queue after a `patch delete` and names any numeric gap the
 * removal opens under `patchPolicy.allowGaps: false`.
 *
 * The delete itself succeeds either way; the gap only surfaces on the next
 * `lint --per-patch`, `re-export` or `verify`, which is the wrong moment to
 * learn that the queue needs a refill or a `patch compact`. Diffing the
 * policy evaluation of the current manifest against the projected one keeps
 * the arithmetic in `evaluatePatchPolicy`, so this module never re-derives
 * what counts as a gap.
 */

import { buildProjectedManifest, evaluatePatchPolicy } from '../../core/patch-policy.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';

const GAP_MESSAGE_PATTERN = /^(?<range>.+?) has numeric gap\(s\): (?<orders>[^.]+)\./;

/**
 * Describes each `numeric-gap` issue the queue would gain once `target` is
 * removed. Returns one operator-facing line per newly gapped range, or an
 * empty array when the policy allows gaps or the removal opens none (for
 * example deleting the last patch of a range).
 *
 * @param config - Loaded project configuration
 * @param manifest - Current patch manifest
 * @param target - Patch about to be deleted
 */
export function describeProjectedGaps(
  config: FireForgeConfig,
  manifest: PatchesManifest,
  target: PatchMetadata
): string[] {
  if (config.patchPolicy?.allowGaps !== false) return [];
  const projected = buildProjectedManifest(
    manifest,
    manifest.patches.filter((patch) => patch.filename !== target.filename)
  );
  const gapKey = (issue: { filename: string; message: string }): string =>
    `${issue.filename}|${issue.message}`;
  const existing = new Set(
    evaluatePatchPolicy(config, manifest)
      .filter((issue) => issue.code === 'numeric-gap')
      .map(gapKey)
  );
  return evaluatePatchPolicy(config, projected)
    .filter((issue) => issue.code === 'numeric-gap' && !existing.has(gapKey(issue)))
    .map((issue) => formatGapNotice(target.filename, issue.message));
}

function formatGapNotice(targetFilename: string, message: string): string {
  const match = GAP_MESSAGE_PATTERN.exec(message);
  const range = match?.groups?.['range'] ?? message;
  const orders = match?.groups?.['orders'] ?? '';
  const fill = orders.split(',')[0]?.trim() ?? '<n>';
  const where = orders ? `a gap at ${orders}` : 'a numeric gap';
  return (
    `deleting ${targetFilename} leaves ${range} with ${where}; the queue will fail ` +
    'numeric-gap (patchPolicy.allowGaps is false) until ' +
    `"fireforge export --order ${fill}" fills it or "fireforge patch compact" renumbers.`
  );
}
