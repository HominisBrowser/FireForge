// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch move-files <from> <to> --create --order <n>` — creates
 * the target patch at the requested sparse order and moves the files into it
 * as one transaction. This is the transactional bootstrap of a split:
 * without it, moving files into a not-yet-existing patch requires a manual
 * shrink-then-export dance with hand-repointed staged-dependency owners.
 *
 * Mirrors `patch split` end-to-end (same planning, projection lint, policy
 * enforcement, and locked commit); the `<to>` argument becomes the new
 * patch's name/slug the way `split --name` does.
 */

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { assertConfirmationAvailable, confirmDestructive } from '../../core/destructive.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
import { loadPatchesManifest, resolvePatchIdentifier } from '../../core/patch-manifest.js';
import { enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { PatchMoveFilesOptions } from '../../types/commands/index.js';
import { info, intro, outro, success } from '../../utils/logger.js';
import { normalizePatchDisplayName } from '../../utils/validation.js';
import { resolvePlacementPlan } from '../export-flow.js';
import { runPatchLint } from '../export-shared.js';
import { commitPatchSplit } from './split.js';
import {
  assertSourceOwnsFiles,
  buildNewPatchMetadata,
  buildSplitDiff,
  buildSplitSummary,
  findOwnerRewriteHolders,
  projectSplitManifest,
  runProjectedSplitLint,
  type SplitPlan,
} from './split-plan.js';

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

  // Refuse a prompt-less run BEFORE the diff/lint work, not after it.
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
  // category prefixes; the manifest display name must agree with the bare-slug
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
    // Populated by runProjectedSplitLint below (forward edges into the new patch).
    stagedDependencyAdditions: new Map(),
  };

  // Per-patch lint both projected bodies, threading the source patch's
  // tier/lintIgnore so an intentional-advisory patch can still move files.
  // The whole-queue context (built once, with the config so it carries the
  // same patch-policy shape as the committed `lint --per-patch` gate) makes
  // cross-patch `resource:///` imports and sibling head.js harness roots
  // resolve exactly as they will after the move lands — without it the
  // projection lint is blind.
  const patchQueueCtx = await buildPatchQueueContext(paths.patches, config);
  const ignoreChecks = source.lintIgnore ? new Set<string>(source.lintIgnore) : undefined;
  await runPatchLint(
    paths.engine,
    remainingFiles,
    remainingDiff,
    config,
    options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    source.tier
  );
  await runPatchLint(
    paths.engine,
    movedFiles,
    movedDiff,
    config,
    options.skipLint,
    patchQueueCtx,
    ignoreChecks,
    source.tier
  );

  const { conflicts, stagedDependencyAdditions } = runProjectedSplitLint(plan, patchQueueCtx);
  plan.stagedDependencyAdditions = stagedDependencyAdditions;
  const newMetadata = buildNewPatchMetadata(plan, config);
  enforcePatchPolicy({
    config,
    manifest: projectSplitManifest(manifest, plan, newMetadata),
    command: 'patch move-files --create',
    forceUnsafe: options.forceUnsafe === true,
    hints: {
      'description-required':
        'Pass --description "<text>" (or -d) on this command to set the created patch\'s description.',
    },
  });

  const decision = await confirmDestructive({
    operation: 'patch-move-files-create',
    title: `Create ${placement.newFilename} (order ${placement.insertionOrder}) and move ${movedFiles.length} file(s) out of ${source.filename}`,
    summary: buildSplitSummary(plan),
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
  if (decision === 'dry-run') {
    outro('Dry run complete — no changes made');
    return;
  }
  if (decision === 'declined') {
    outro('Move cancelled');
    return;
  }

  await commitPatchSplit(paths.patches, plan, newMetadata, options, config);

  success(
    `Created ${placement.newFilename} (order ${String(placement.insertionOrder).padStart(3, '0')}) ` +
      `and moved ${plan.movedFiles.length} file(s) out of ${source.filename}`
  );
  if (plan.ownerRewrites.length > 0) {
    info(`Re-pointed staged-dependency owners in: ${plan.ownerRewrites.join(', ')}`);
  }
  outro('Move complete');
}
