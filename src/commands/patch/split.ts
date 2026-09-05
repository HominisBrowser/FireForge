// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch split <source> --files <p...> --name <n>` — moves files
 * out of an existing patch into a brand-new patch as one transaction.
 *
 * Splitting a patch whose files have inbound forward-imports otherwise
 * requires a precise manual order: re-point each staged-dependency owner at
 * a not-yet-created patch, shrink the source via
 * `re-export --files --allow-shrink`, then `export --order` — any other
 * order refuses or needs `--force-unsafe`. Split performs the shrink, the
 * new-patch creation, and the dependent owner rewrites under one
 * patch-directory lock with rollback, validating only the final projection.
 *
 * Preconditions match `re-export`: the engine worktree must currently
 * reflect both patches' content, because both bodies are regenerated from
 * the worktree.
 */

import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { assertConfirmationAvailable, confirmDestructive } from '../../core/destructive.js';
import { appendHistoryBestEffort } from '../../core/history-log.js';
import { formatPatchNotFoundError } from '../../core/patch-identifier-suggest.js';
import { buildPatchQueueContext } from '../../core/patch-lint.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifest,
  renumberPatchesInManifest,
  resolvePatchIdentifier,
  savePatchesManifest,
  validatePatchesManifest,
} from '../../core/patch-manifest.js';
import { enforcePatchPolicy } from '../../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchMetadata, PatchSplitOptions } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { toError } from '../../utils/errors.js';
import { readText, removeFile, writeText } from '../../utils/fs.js';
import { info, intro, outro, success, warn } from '../../utils/logger.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
} from '../../utils/options.js';
import { normalizePatchDisplayName, parsePositiveIntegerFlag } from '../../utils/validation.js';
import { proceedAfterDecision } from '../destructive-decision.js';
import { placementPlansEqual, resolvePlacementPlan } from '../export-flow.js';
import { runPatchLint } from '../export-shared.js';
import {
  assertSourceOwnsFiles,
  buildNewPatchMetadata,
  buildSplitDiff,
  buildSplitSummary,
  findOwnerRewriteHolders,
  mergeStagedForwardImports,
  projectSplitManifest,
  rewriteSplitOwners,
  runProjectedSplitLint,
  type SplitPlan,
} from './split-plan.js';

/**
 * Commits a confirmed split under the patch directory lock: renumber →
 * write new patch body → write shrunken source body → single manifest
 * rewrite (new row + shrunken source row + owner rewrites). On any
 * failure the steps are rolled back in reverse order. Exported for
 * `patch move-files --create`, which commits the same transaction shape.
 */
export async function commitPatchSplit(
  patchesDir: string,
  plan: SplitPlan,
  newMetadata: PatchMetadata,
  options: Pick<PatchSplitOptions, 'yes' | 'forceUnsafe' | 'waitLock'>,
  config: FireForgeConfig
): Promise<void> {
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const manifest = await loadPatchesManifest(patchesDir);
      if (!manifest) throw new GeneralError('Manifest disappeared while waiting for lock.');
      const current = manifest.patches.find((p) => p.filename === plan.source.filename);
      if (!current || current.filesAffected.join('\n') !== plan.source.filesAffected.join('\n')) {
        throw new InvalidArgumentError(
          'Patch queue changed while waiting for split confirmation. Re-run the command.',
          'patch split'
        );
      }
      const currentPlacement = await resolvePlacementPlan(
        patchesDir,
        plan.placementOptions,
        plan.category,
        plan.name,
        config
      );
      if (!placementPlansEqual(currentPlacement, plan.placement)) {
        throw new InvalidArgumentError(
          'Patch queue changed while waiting for split confirmation. Re-run the command.',
          'patch split'
        );
      }

      const movedSet = new Set(plan.movedFiles);
      const effectiveSourceFilename =
        plan.placement.renameMap.get(plan.source.filename)?.newFilename ?? plan.source.filename;
      const newPatchPath = join(patchesDir, plan.placement.newFilename);
      const sourcePathBefore = join(patchesDir, plan.source.filename);
      const sourcePathAfter = join(patchesDir, effectiveSourceFilename);
      const originalSourceBody = await readText(sourcePathBefore);
      let renumberApplied = false;
      let newPatchWritten = false;
      let sourceRewritten = false;

      try {
        if (plan.placement.renameMap.size > 0) {
          await renumberPatchesInManifest(patchesDir, plan.placement.renameMap);
          renumberApplied = true;
        }
        await writeText(newPatchPath, plan.movedDiff);
        newPatchWritten = true;
        await writeText(sourcePathAfter, plan.remainingDiff);
        sourceRewritten = true;

        const fresh = await loadPatchesManifest(patchesDir);
        if (!fresh) throw new GeneralError('Manifest disappeared during split commit.');
        const updatedPatches = fresh.patches.map((patch) => {
          let withOwners = rewriteSplitOwners(
            patch,
            effectiveSourceFilename,
            movedSet,
            plan.placement.newFilename
          );
          // Persist the auto-declared forward edges into the new patch so the
          // real per-patch gate stays clean (keyed by post-rename filename).
          const decls = plan.stagedDependencyAdditions.get(withOwners.filename);
          if (decls?.length) {
            withOwners = mergeStagedForwardImports(withOwners, decls);
          }
          if (patch.filename !== effectiveSourceFilename) return withOwners;
          return { ...withOwners, filesAffected: plan.remainingFiles };
        });
        updatedPatches.push(newMetadata);
        updatedPatches.sort((a, b) => a.order - b.order || a.filename.localeCompare(b.filename));
        const updated = validatePatchesManifest({ ...fresh, patches: updatedPatches });
        await savePatchesManifest(patchesDir, updated);

        await appendHistoryBestEffort(
          patchesDir,
          {
            operation: 'patch-split',
            args: {
              source: effectiveSourceFilename,
              newFilename: plan.placement.newFilename,
              order: plan.placement.insertionOrder,
              files: plan.movedFiles,
              ownerRewrites: plan.ownerRewrites,
              renames: [...plan.placement.renameMap.entries()].map(([from, entry]) => ({
                from,
                to: entry.newFilename,
              })),
            },
            ...(options.yes === true ? { yes: true } : {}),
            ...(options.forceUnsafe === true ? { unsafeOverride: true } : {}),
            result: 'ok',
          },
          `patch split committed`
        );
      } catch (error: unknown) {
        // Reverse-order rollback; each step warns on its own failure so the
        // original error stays visible.
        if (sourceRewritten) {
          try {
            await writeText(sourcePathAfter, originalSourceBody);
          } catch (rollbackError: unknown) {
            warn(
              `Rollback warning: could not restore source body: ${toError(rollbackError).message}`
            );
          }
        }
        if (newPatchWritten) {
          try {
            await removeFile(newPatchPath);
          } catch (rollbackError: unknown) {
            warn(
              `Rollback warning: could not remove new patch file: ${toError(rollbackError).message}`
            );
          }
        }
        if (renumberApplied) {
          const inverseMap = new Map(
            [...plan.placement.renameMap.entries()].map(([oldFilename, entry]) => [
              entry.newFilename,
              {
                newOrder: parseInt(oldFilename.split('-')[0] ?? '0', 10),
                newFilename: oldFilename,
              },
            ])
          );
          try {
            await renumberPatchesInManifest(patchesDir, inverseMap);
          } catch (rollbackError: unknown) {
            warn(`Rollback warning: could not invert renumber: ${toError(rollbackError).message}`);
          }
        }
        try {
          await savePatchesManifest(patchesDir, manifest);
        } catch (rollbackError: unknown) {
          warn(`Rollback warning: could not restore manifest: ${toError(rollbackError).message}`);
        }
        throw error;
      }
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch split' }
  );
}

/**
 * Runs the `patch split` command: plans the split, lints the projection,
 * confirms, and commits transactionally.
 */
export async function patchSplitCommand(
  projectRoot: string,
  sourceId: string,
  options: PatchSplitOptions
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch split (dry run)' : 'FireForge patch split');

  // Refuse a prompt-less run BEFORE the diff/lint work, not after it.
  assertConfirmationAvailable('patch split', options);

  const paths = getProjectPaths(projectRoot);
  const config = await loadConfig(projectRoot);
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches in manifest.');
  }
  const source = resolvePatchIdentifier(sourceId, manifest.patches);
  if (!source) {
    throw new InvalidArgumentError(
      formatPatchNotFoundError(sourceId, manifest.patches),
      'patch split'
    );
  }

  const movedFiles = [...new Set(options.files.map((f) => f.trim()).filter(Boolean))].sort();
  if (movedFiles.length === 0) {
    throw new InvalidArgumentError('patch split requires at least one --files path.', '--files');
  }
  assertSourceOwnsFiles(source, movedFiles);
  const movedSet = new Set(movedFiles);
  const remainingFiles = source.filesAffected.filter((f) => !movedSet.has(f));
  if (remainingFiles.length === 0) {
    throw new InvalidArgumentError(
      `Splitting every file out of ${source.filename} would leave it empty. ` +
        'Use "fireforge patch rename" / "fireforge patch reorder" to repurpose or move the whole patch instead.',
      '--files'
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
  const placementOptions = pickDefined({
    order: options.order,
    before: options.before,
    after:
      options.after ??
      (options.order === undefined && options.before === undefined ? source.filename : undefined),
  });
  const placement = await resolvePlacementPlan(
    paths.patches,
    placementOptions,
    category,
    options.name,
    config
  );

  // The filename slug pipeline strips redundant category prefixes; the
  // manifest display name must agree with the bare-slug naming policy,
  // exactly as `export --name` already does.
  const displayName = normalizePatchDisplayName(options.name, category);
  if (displayName !== options.name) {
    info(
      `Patch name normalized: "${options.name}" → "${displayName}" (the filename carries the order and category prefix).`
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
  // tier/lintIgnore so an intentional-advisory patch can still split.
  // The whole-queue context (built once, with the config for committed-gate
  // parity) resolves cross-patch imports and sibling head.js harness roots
  // instead of linting each projected body blind.
  const patchQueueCtx = await buildPatchQueueContext(paths.patches, config);
  const ignoreChecks = source.lintIgnore ? new Set<string>(source.lintIgnore) : undefined;
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

  const { conflicts, stagedDependencyAdditions } = runProjectedSplitLint(plan, patchQueueCtx);
  plan.stagedDependencyAdditions = stagedDependencyAdditions;
  const newMetadata = buildNewPatchMetadata(plan, config);
  enforcePatchPolicy({
    config,
    manifest: projectSplitManifest(manifest, plan, newMetadata),
    command: 'patch split',
    forceUnsafe: options.forceUnsafe === true,
  });

  const decision = await confirmDestructive({
    operation: 'patch-split',
    title: `Split ${plan.movedFiles.length} file(s) out of ${source.filename} into ${placement.newFilename}`,
    summary: buildSplitSummary(plan),
    yes: options.yes === true,
    dryRun: options.dryRun === true,
    unsafeOverride: options.forceUnsafe === true,
    conflicts,
  });
  if (!proceedAfterDecision(decision, 'Split cancelled')) return;

  await commitPatchSplit(paths.patches, plan, newMetadata, options, config);

  success(
    `Split ${source.filename}: ${placement.newFilename} now owns ${plan.movedFiles.length} file(s)`
  );
  if (plan.ownerRewrites.length > 0) {
    info(`Re-pointed staged-dependency owners in: ${plan.ownerRewrites.join(', ')}`);
  }
  outro('Split complete');
}

/**
 * Registers the `patch split` subcommand on the `patch` parent.
 */
export function registerPatchSplit(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('split <source>')
    .description(
      'Move files out of a patch into a new patch as one transaction (shrink + create + staged-dependency owner rewrites)'
    )
    .requiredOption(
      '--files <path...>',
      'Engine-relative files to move from the source patch to the new patch'
    )
    .requiredOption('--name <name>', 'Name for the new patch')
    .option('--category <category>', "Category for the new patch (default: the source patch's)")
    .option('--description <desc>', 'Description for the new patch')
    .option(
      '--order <n>',
      'Exact sparse order for the new patch',
      commanderArgParser((raw: string) => parsePositiveIntegerFlag('--order', raw))
    )
    .option('--before <patch>', 'Place the new patch before this patch')
    .option('--after <patch>', 'Place the new patch after this patch (default: the source patch)')
    .option('--dry-run', 'Show what would happen without writing')
    .option('-y, --yes', 'Skip confirmation prompt (required for non-TTY)')
    .option('--force-unsafe', 'Bypass projected-lint refusals')
    .option('--skip-lint', 'Skip per-patch lint of the projected bodies');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (
        sourceId: string,
        options: {
          files: string[];
          name: string;
          category?: string;
          description?: string;
          order?: number;
          before?: string;
          after?: string;
          dryRun?: boolean;
          yes?: boolean;
          forceUnsafe?: boolean;
          skipLint?: boolean;
          waitLock?: number | boolean;
        }
      ) => {
        await patchSplitCommand(getProjectRoot(), sourceId, {
          files: options.files,
          name: options.name,
          ...pickDefined({
            category: options.category,
            description: options.description,
            order: options.order,
            before: options.before,
            after: options.after,
            dryRun: options.dryRun,
            yes: options.yes,
            forceUnsafe: options.forceUnsafe,
            skipLint: options.skipLint,
            waitLock: options.waitLock,
          }),
        });
      }
    )
  );
}
