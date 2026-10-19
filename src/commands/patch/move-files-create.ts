// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch move-files <from> <to> --create --order <n>` creates
 * the target patch at the requested sparse order and moves the files into it
 * as one transaction. This is the transactional bootstrap of a split:
 * without it, moving files into a not-yet-existing patch requires a manual
 * shrink-then-export dance with hand-repointed staged-dependency owners.
 *
 * Mirrors `patch split` end-to-end (same planning, projection lint, policy
 * enforcement, and locked commit). The `<to>` argument becomes the new
 * patch's name/slug the way `split --name` does.
 */

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { assertConfirmationAvailable, confirmDestructive } from '../../core/destructive.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
import { buildLintIgnoreChecks } from '../../core/patch-lint-ignore.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { formatPatchOrder } from '../../core/patch-parse.js';
import { enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { PatchMoveFilesOptions } from '../../types/commands/index.js';
import { info, intro, outro, success } from '../../utils/logger.js';
import { normalizePatchDisplayName } from '../../utils/validation.js';
import { withDeclarationsReport } from '../declarations-report.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { resolvePlacementPlan } from '../export-flow.js';
import { runPatchLint } from '../export-shared.js';
import { commitPatchSplit, reportSplitStagedChanges } from './split.js';
import {
  assertSourceOwnsFiles,
  buildNewPatchMetadata,
  buildSplitDiff,
  buildSplitSummary,
  projectSplitManifest,
  runProjectedSplitLint,
  splitDeclarationRenamer,
  type SplitPlan,
} from './split-plan.js';
import { emptyStagedMaintenance, findOwnerRewriteHolders } from './split-staged.js';

/**
 * Runs `patch move-files --create --order <n>`: plans the create+move as a
 * split, lints the projection, confirms, and commits transactionally.
 */
export async function patchMoveFilesCreateCommand(
  projectRoot: string,
  fromIdentifier: string,
  newPatchName: string,
  options: PatchMoveFilesOptions & { order: number }
): Promise<void> {
  intro(
    options.dryRun === true
      ? 'FireForge patch move-files --create (dry run)'
      : 'FireForge patch move-files --create'
  );

  // Refuse a prompt-less run before the diff/lint work, not after it.
  assertConfirmationAvailable('patch move-files --create', options);

  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }
  const source = resolvePatchIdentifier(fromIdentifier, manifest.patches);
  if (!source) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(fromIdentifier, manifest.patches),
      'patch move-files'
    );
  }
  const existingTarget = resolvePatchIdentifier(newPatchName, manifest.patches);
  if (existingTarget) {
    throw new InvalidArgumentError(
      `--create target "${newPatchName}" already exists as ${existingTarget.filename}. ` +
        'Omit --create to preview a move into the existing patch, or pick a new patch name.',
      '--create'
    );
  }

  const movedFiles = [...new Set((options.file ?? []).map((f) => f.trim()).filter(Boolean))].sort();
  if (movedFiles.length === 0) {
    throw new InvalidArgumentError('Specify at least one --file path to move.', '--file');
  }
  assertSourceOwnsFiles(source, movedFiles);
  const movedSet = new Set(movedFiles);
  const remainingFiles = source.filesAffected.filter((f) => !movedSet.has(f));
  if (remainingFiles.length === 0) {
    throw new InvalidArgumentError(
      `Moving every file out of ${source.filename} would leave it empty. ` +
        'Use "fireforge patch rename" / "fireforge patch reorder" to repurpose or move the whole patch instead.',
      '--file'
    );
  }

  const movedDiff = await buildSplitDiff(paths.engine, movedFiles, 'moved', source.filename);
  const remainingDiff = await buildSplitDiff(
    paths.engine,
    remainingFiles,
    'remaining',
    source.filename
  );

  const category = options.category ?? source.category;
  const placementOptions = { order: options.order };
  const placement = await resolvePlacementPlan(
    paths.patches,
    placementOptions,
    category,
    newPatchName,
    config
  );

  // The filename slug pipeline (resolvePlacementPlan above) strips redundant
  // category prefixes. The manifest display name must agree with the bare-slug
  // naming policy, exactly as `export --name` already does.
  const displayName = normalizePatchDisplayName(newPatchName, category);
  if (displayName !== newPatchName) {
    info(
      `Patch name normalized: "${newPatchName}" → "${displayName}" (the filename carries the order and category prefix).`
    );
  }

  const plan: SplitPlan = {
    source,
    movedFiles,
    remainingFiles,
    movedDiff,
    remainingDiff,
    placement,
    placementOptions,
    category,
    name: displayName,
    description: options.description ?? '',
    ownerRewrites: findOwnerRewriteHolders(manifest.patches, source.filename, movedSet),
    // Populated by runProjectedSplitLint below (forward edges into the new
    // patch, and the declarations the move re-homes or makes unused).
    stagedDependencyAdditions: new Map(),
    stagedMaintenance: emptyStagedMaintenance(),
  };

  // Policy first: the projected manifest (orders, ranges, the gap rule)
  // does not depend on the lint below, so a refused --order fails before
  // the per-patch and projected lint passes instead of after them.
  enforcePatchPolicy({
    config,
    manifest: projectSplitManifest(manifest, plan, buildNewPatchMetadata(plan, config)),
    command: 'patch move-files --create',
    forceUnsafe: options.forceUnsafe === true,
    hints: {
      'description-required':
        'Pass --description "<text>" (or -d) on this command to set the created patch\'s description.',
      'numeric-gap':
        'With patchPolicy.allowGaps: false, orders are contiguous within a range: --order must ' +
        "fill an existing gap or a retired slot, or take the number right after the range's last " +
        'patch. A number reserved past a gap cannot be used until the numbers before it exist.',
    },
  });

  // Per-patch lint both projected bodies, threading the source patch's
  // tier/lintIgnore so an intentional-advisory patch can still move files.
  // The whole-queue context (built once, with the config so it carries the
  // same patch-policy shape as the committed `lint --per-patch` gate) makes
  // cross-patch `resource:///` imports and sibling head.js harness roots
  // resolve exactly as they will after the move lands. Without it the
  // projection lint is blind.
  const patchQueueCtx = await buildPatchQueueContext(paths.patches, config);
  const ignoreChecks = buildLintIgnoreChecks(source.lintIgnore);
  await runPatchLint({
    engineDir: paths.engine,
    filesAffected: remainingFiles,
    diffContent: remainingDiff,
    config,
    skipLint: options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    patchTier: source.tier,
  });
  await runPatchLint({
    engineDir: paths.engine,
    filesAffected: movedFiles,
    diffContent: movedDiff,
    config,
    skipLint: options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    patchTier: source.tier,
  });

  const projected = runProjectedSplitLint(plan, patchQueueCtx);
  plan.stagedDependencyAdditions = projected.stagedDependencyAdditions;
  plan.stagedMaintenance = projected.stagedMaintenance;
  const conflicts = await withDeclarationsReport(projected.conflicts, {
    projectRoot,
    regressions: projected.regressions,
    out: options.declarationsOut,
    rename: splitDeclarationRenamer(plan),
  });
  const newMetadata = buildNewPatchMetadata(plan, config);

  const decision = await confirmDestructive({
    operation: 'patch-move-files-create',
    title: `Create ${placement.newFilename} (order ${placement.insertionOrder}) and move ${movedFiles.length} file(s) out of ${source.filename}`,
    summary: buildSplitSummary(plan),
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
  if (!proceedAfterDecision(decision, 'Move cancelled')) return;

  await commitPatchSplit(paths.patches, plan, newMetadata, options, config);

  success(
    `Created ${placement.newFilename} (order ${formatPatchOrder(placement.insertionOrder)}) ` +
      `and moved ${plan.movedFiles.length} file(s) out of ${source.filename}`
  );
  reportSplitStagedChanges(plan);
  outro('Move complete');
}
