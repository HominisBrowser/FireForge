// SPDX-License-Identifier: EUPL-1.2
/**
 * Placement-flag gating for `fireforge export`, split out of `export.ts`
 * to keep the command body inside the per-function and per-file line
 * budgets. `gatePlacementPlan` owns every policy/confirmation decision a
 * placement export makes before the locked commit in `export.ts` runs.
 */

import { confirmDestructive } from '../core/destructive.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import {
  applyRenameMapToManifest,
  buildProjectedManifest,
  enforcePatchPolicy,
} from '../core/patch-policy.js';
import { buildPatchSourceMetadata } from '../core/patch-source-metadata.js';
import { InvalidArgumentError } from '../errors/base.js';
import type { ExportOptions, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import type { SpinnerHandle } from '../utils/logger.js';
import { outro } from '../utils/logger.js';
import {
  type PlacementPlan,
  placementSummary,
  projectPlacementForLint,
  resolvePlacementPlan,
} from './export-flow.js';

/**
 * Spreadable optional metadata (`tier`, `lintIgnore`) derived from the
 * export flags. Every manifest-row construction site in this command
 * shares this shape; with exactOptionalPropertyTypes the keys must be
 * omitted entirely (not set to undefined) when the flags are absent.
 */
export function patchMetadataExtras(
  options: ExportOptions
): Partial<Pick<PatchMetadata, 'tier' | 'lintIgnore'>> {
  return {
    ...(options.tier !== undefined ? { tier: options.tier } : {}),
    ...(options.lintIgnore !== undefined && options.lintIgnore.length > 0
      ? { lintIgnore: options.lintIgnore }
      : {}),
  };
}

/**
 * Resolves and gates the placement plan when any placement flag
 * (`--order`/`--before`/`--after`) was given: rejects the `--supersede`
 * combination, enforces reserved ranges and patch policy against the
 * projected manifest, and routes destructive renumbers (or dry-runs)
 * through `confirmDestructive`. Returns the plan to commit, or `'stop'`
 * when the command should end here (dry-run rendered or operator
 * cancelled — the corresponding outro has already been printed).
 */
export async function gatePlacementPlan(args: {
  patchesDir: string;
  options: ExportOptions;
  selectedCategory: string;
  patchName: string;
  description: string;
  filesAffected: string[];
  diff: string;
  config: FireForgeConfig;
  isDryRun: boolean;
  s: SpinnerHandle;
}): Promise<PlacementPlan | 'stop'> {
  const {
    patchesDir,
    options,
    selectedCategory,
    patchName,
    description,
    filesAffected,
    diff,
    config,
    isDryRun,
    s,
  } = args;
  if (options.supersede) {
    throw new InvalidArgumentError(
      'Placement flags (--order/--before/--after) cannot be combined with --supersede.',
      'export placement'
    );
  }
  // resolvePlacementPlan runs the reserved-range gate itself when config
  // is passed — one up-front error per run instead of per-patch findings.
  const placementPlan = await resolvePlacementPlan(
    patchesDir,
    options,
    selectedCategory,
    patchName,
    config
  );

  const currentManifest = await loadPatchesManifest(patchesDir);
  const conflicts = await projectPlacementForLint(patchesDir, placementPlan, diff);
  const renamed =
    currentManifest !== null
      ? applyRenameMapToManifest(currentManifest, placementPlan.renameMap)
      : buildProjectedManifest(null, []);
  enforcePatchPolicy({
    config,
    manifest: buildProjectedManifest(renamed, [
      ...renamed.patches,
      {
        filename: placementPlan.newFilename,
        order: placementPlan.insertionOrder,
        category: selectedCategory,
        name: patchName,
        description,
        createdAt: new Date().toISOString(),
        ...buildPatchSourceMetadata(config.firefox),
        filesAffected,
        ...patchMetadataExtras(options),
      },
    ]),
    command: 'export',
    forceUnsafe: options.forceUnsafe === true,
  });
  const summary = placementSummary(placementPlan);
  const renameCount = placementPlan.renameMap.size;

  // Route through confirmDestructive when the operation is destructive
  // enough to warrant a prompt (more than one rename) OR when the user
  // asked for a dry-run. The dry-run branch must always print the
  // placement summary — previously, single-rename/no-rename dry-runs
  // exited silently with no filename or projected layout.
  if (renameCount > 1 || isDryRun) {
    s.stop();
    const decision = await confirmDestructive({
      operation: 'export-order',
      title: `Export with placement at order ${placementPlan.insertionOrder}`,
      summary,
      yes: options.yes === true,
      dryRun: isDryRun,
      unsafeOverride: options.forceUnsafe === true,
      conflicts,
    });
    if (decision === 'dry-run') {
      outro('Dry run complete — no changes made');
      return 'stop';
    }
    if (decision === 'cancelled') {
      outro('Export cancelled');
      return 'stop';
    }
  } else if (conflicts && options.forceUnsafe !== true) {
    s.stop();
    throw new InvalidArgumentError(
      `Refusing to run export: ${conflicts.reason}. ` +
        'If the conflict names files owned by another patch (e.g. duplicate-new-file-creation), ' +
        're-run the export with an explicit file list that leaves those files with their owner — ' +
        'do NOT bypass with --force-unsafe. Pass --force-unsafe only for a reviewed placement conflict.',
      '--force-unsafe'
    );
  }
  return placementPlan;
}
