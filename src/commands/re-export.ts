// SPDX-License-Identifier: EUPL-1.2
import { multiselect } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { stdioIsInteractive } from '../core/destructive.js';
import { assertEngineGitReady } from '../core/engine-precondition.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { formatPatchNotFoundError } from '../core/patch-identifier-suggest.js';
import {
  loadPatchesManifest,
  resolvePatchIdentifier,
  stampPatchVersions,
} from '../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { elapsedSince } from '../utils/elapsed.js';
import { toError } from '../utils/errors.js';
import {
  cancel,
  info,
  intro,
  isCancel,
  outro,
  spinner,
  type SpinnerHandle,
  success,
  warn,
} from '../utils/logger.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import {
  loadScanFilesAssignments,
  withDryRunPurityGuard,
  withDryRunReExportLock,
} from './re-export-bulk-scan.js';
import type { ForeignDriftContext } from './re-export-drift.js';
import { warnUnseenExpectedDrift } from './re-export-drift.js';
import { reExportFilesInPlace } from './re-export-files.js';
import { buildReExportLintContext, finishReExportLint } from './re-export-lint.js';
import {
  applyReExportFilesPositionalFolding,
  validateReExportOptionCombinations,
} from './re-export-options.js';
import { normalizeEngineRelativeInput, normalizeScanFiles } from './re-export-scan.js';
import { reExportSinglePatchWithIndexLockRetry } from './re-export-single.js';

async function resolveSelectedPatches(
  patches: string[],
  options: ReExportOptions,
  manifest: PatchesManifest
): Promise<PatchMetadata[] | null> {
  if (options.all) {
    return [...manifest.patches];
  }

  if (patches.length > 0) {
    const selectedPatches: PatchMetadata[] = [];
    for (const identifier of patches) {
      const match = resolvePatchIdentifier(identifier, manifest.patches);
      if (!match) {
        // Suggest, never dump: a wrong guess would otherwise print the
        // whole ~300-entry manifest, burying the error it was reporting.
        throw new InvalidArgumentError(
          formatPatchNotFoundError(identifier, manifest.patches),
          identifier
        );
      }
      selectedPatches.push(match);
    }
    return selectedPatches;
  }

  // No patches specified — prompt or error
  const isInteractive = stdioIsInteractive();

  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Specify patch identifiers or use --all in non-interactive mode.\n\n' +
        'Usage: fireforge re-export [patches...] or fireforge re-export --all',
      'patches'
    );
  }

  const selected = await multiselect({
    message: 'Select patches to re-export:',
    options: manifest.patches.map((patch) => ({
      value: patch.filename,
      label: `${patch.filename} — ${patch.description || patch.name}`,
    })),
  });

  if (isCancel(selected)) {
    cancel('Re-export cancelled');
    return null;
  }

  const selectedFilenames = selected;
  return manifest.patches.filter((p) => selectedFilenames.includes(p.filename));
}

/**
 * Runs the re-export command to regenerate existing patches from current engine state.
 * @param projectRoot - Root directory of the project
 * @param patches - Patch identifiers (numbers or filenames)
 * @param options - Re-export options
 */
export async function reExportCommand(
  projectRoot: string,
  patches: string[],
  options: ReExportOptions
): Promise<void> {
  const normalizedScanFiles = normalizeScanFiles(options.scanFiles);
  if (normalizedScanFiles !== undefined) {
    options = { ...options, scanFiles: normalizedScanFiles };
  } else if (options.scanFiles !== undefined) {
    const cleanedOptions: ReExportOptions = { ...options };
    delete cleanedOptions.scanFiles;
    options = cleanedOptions;
  }

  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Re-export (dry run)' : 'FireForge Re-export');

  // Accept export-style space-separated paths after --files by folding
  // path-shaped extra positionals into the file list.
  ({ patches, options } = applyReExportFilesPositionalFolding(patches, options));

  validateReExportOptionCombinations(patches, options);

  const paths = getProjectPaths(projectRoot);

  await assertEngineGitReady(paths.engine);

  // Load the manifest
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError(
      'No patches found in manifest. Run "fireforge export" to create patches first.'
    );
  }

  const scanFilesByPatch =
    options.scanFilesManifest !== undefined
      ? await loadScanFilesAssignments(options.scanFilesManifest, manifest)
      : undefined;

  // Resolve which patches to re-export
  const selectedPatches =
    scanFilesByPatch !== undefined
      ? manifest.patches.filter((patch) => scanFilesByPatch.has(patch.filename))
      : await resolveSelectedPatches(patches, options, manifest);
  if (!selectedPatches) return;

  if (selectedPatches.length === 0) {
    warn('No patches selected');
    outro('Nothing to re-export');
    return;
  }

  if (scanFilesByPatch !== undefined) {
    info(`Bulk scan assignments from ${options.scanFilesManifest}`);
    for (const patch of selectedPatches) {
      const files = scanFilesByPatch.get(patch.filename) ?? [];
      info(`  ${patch.filename} <= ${files.length} file(s)`);
      for (const file of files) info(`    + ${file}`);
    }
  }

  // --files path: handled end-to-end here so we can lint the *projected*
  // shrunken state (not the current queue) and skip the generic re-export
  // loop. The projection substitutes the target patch's diff and newFiles
  // with the freshly computed content, then runs lintPatchQueue so any
  // forward-import introduced or uncovered by the shrink is caught before
  // we write anything.
  if (options.files !== undefined) {
    const filesConfig = await loadConfig(projectRoot);
    await withDryRunReExportLock(paths.fireforgeDir, isDryRun, () =>
      withDryRunPurityGuard(paths.engine, paths.patches, isDryRun, () =>
        reExportFilesInPlace(paths, selectedPatches, options, filesConfig)
      )
    );
    return;
  }

  const config = await loadConfig(projectRoot);

  // Classification inputs for the scan-less adjacency advisory, computed
  // once for the whole run.
  const adjacentCtx: AdjacentUnmanagedContext = {
    binaryName: config.binaryName,
    furnacePrefixes: await collectFurnaceManagedPrefixes(paths.root),
    refuseAdjacentUnmanaged: options.refuseAdjacentUnmanaged === true,
    approvedUnmanaged: new Set(
      (options.expectUnmanaged ?? []).map((file) =>
        normalizeEngineRelativeInput(file, '--expect-unmanaged')
      )
    ),
    approvedSeen: new Set(),
    refusals: [],
  };

  const driftCtx = buildForeignDriftContext(options);

  // Hoisted lint context, one per run: queue context + checkJs
  // program + per-patch result cache, shared across every loop iteration.
  const lintCtx = await buildReExportLintContext(
    projectRoot,
    paths,
    config,
    options.noCache === true
  );

  let reExported = 0;
  const reExportedFilenames: string[] = [];
  const failedFilenames: string[] = [];
  const progress = spinner('Preparing re-export...');
  const startedAt = Date.now();

  await withDryRunReExportLock(paths.fireforgeDir, isDryRun, async () =>
    withDryRunPurityGuard(paths.engine, paths.patches, isDryRun, async () => {
      for (const [index, patch] of selectedPatches.entries()) {
        const assignedScanFiles = scanFilesByPatch?.get(patch.filename);
        const patchOptions =
          assignedScanFiles !== undefined ? { ...options, scanFiles: assignedScanFiles } : options;
        progress.message(
          `Re-exporting ${index + 1}/${selectedPatches.length}: ${patch.filename} (${patch.filesAffected.length} file(s), ${elapsedSince(startedAt)} elapsed)...`
        );
        try {
          const exported = await reExportSinglePatchWithIndexLockRetry({
            patch,
            paths,
            manifest,
            options: patchOptions,
            isDryRun,
            config,
            adjacentCtx,
            driftCtx,
            lintCtx,
          });
          if (exported) {
            reExported++;
            reExportedFilenames.push(patch.filename);
          }
        } catch (error: unknown) {
          failedFilenames.push(patch.filename);
          warn(`Failed to re-export ${patch.filename}`);
          warn(toError(error).message);
        }
      }
    })
  );

  await finishReExportLint(lintCtx);
  warnUnseenExpectedDrift(driftCtx);
  warnUnseenApprovedUnmanaged(adjacentCtx);
  throwRunLevelRefusals(adjacentCtx, driftCtx, progress);

  if (reExported === 0 && selectedPatches.length > 0) {
    progress.error('Re-export failed');
    throw new GeneralError('All selected patches failed to re-export. Check the errors above.');
  }

  // `--stamp` only fires on a run where every selected patch refreshed
  // cleanly. A partial success would leave some patches with a stale body
  // but a new version — the opposite of the "what I tested, what the
  // manifest says" invariant `sourceEsrVersion` exists to record. A
  // non-empty `reExportedFilenames` with fewer entries than `selectedPatches`
  // means a lint failure or missing-file skip landed somewhere in the loop,
  // which we refuse to version-stamp through.
  const shouldStamp =
    options.stamp === true && !isDryRun && reExported > 0 && reExported === selectedPatches.length;

  if (shouldStamp) {
    await stampPatchVersions(
      paths.patches,
      reExportedFilenames,
      config.firefox.version,
      config.firefox.product
    );
  }

  reportReExportOutcome({
    isDryRun,
    reExported,
    selectedCount: selectedPatches.length,
    reExportedFilenames,
    failedFilenames,
    shouldStamp,
    stampRequested: options.stamp === true,
    config,
    progress,
  });
}

/**
 * Foreign-drift guard context, one per run. `--expect` paths
 * are normalized once here so the per-patch comparison matches
 * them against engine-relative diff-section paths.
 */
function buildForeignDriftContext(options: ReExportOptions): ForeignDriftContext {
  return {
    refuseForeignDrift: options.refuseForeignDrift === true,
    expectedDriftFiles: new Set(
      (options.expect ?? []).map((file) => normalizeEngineRelativeInput(file, '--expect'))
    ),
    expectedSeen: new Set(),
    evaluationRuns: 0,
    refusals: [],
  };
}

/**
 * Names `--expect-unmanaged` paths that were never met this run. A typo'd
 * carve-out silently leaves the refusal armed for the path it was meant to
 * admit — and, worse, reads as an approval that is in force when it is not.
 * A warning rather than a refusal: an approved path legitimately goes unmet
 * when the reviewed file has since been adopted into a patch, which is the
 * outcome the carve-out exists to be retired by.
 */
function warnUnseenApprovedUnmanaged(adjacentCtx: AdjacentUnmanagedContext): void {
  const unseen = [...adjacentCtx.approvedUnmanaged].filter(
    (file) => !adjacentCtx.approvedSeen.has(file)
  );
  if (unseen.length === 0) return;
  warn(
    '--expect-unmanaged path(s) were not met as adjacent unmanaged files this run: ' +
      `${unseen.join(', ')}. ` +
      'Causes, in rough order of likelihood: a typo in the path; the file is now owned by a ' +
      'patch (the carve-out can be dropped); or no selected patch is adjacent to it. The ' +
      'refusal stayed armed for everything else either way.'
  );
}

/**
 * Turns the run's collected `--refuse-adjacent-unmanaged` and
 * `--refuse-foreign-drift` refusals into the non-zero exit,
 * naming every refused patch and the remedy.
 */
function throwRunLevelRefusals(
  adjacentCtx: AdjacentUnmanagedContext,
  driftCtx: ForeignDriftContext,
  progress: SpinnerHandle
): void {
  if (adjacentCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    // Each offender is named with the owned directory that made it
    // adjacent: an unattended run reads only this line, and without the
    // anchor it cannot tell which of a multi-directory patch's locations
    // the file sits beside.
    const offenders = adjacentCtx.refusals
      .map((r) => `${r.patchFilename} (${r.anchored.join(', ')})`)
      .join('; ');
    throw new GeneralError(
      `Refused ${adjacentCtx.refusals.length} patch(es) with adjacent unmanaged files ` +
        `(--refuse-adjacent-unmanaged): ${offenders}. Adjacent means the file sits in a ` +
        `directory the patch already owns a file in. Adopt reviewed files with ` +
        `--scan --scan-file, or export them as a new patch.`
    );
  }

  if (driftCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    const names = driftCtx.refusals.map((r) => r.patchFilename).join(', ');
    const unreadable = driftCtx.refusals.filter((r) => r.reason === 'baseline-unreadable');
    const unreadablePart =
      unreadable.length > 0
        ? ` ${unreadable.length} of these refused because the old patch body was missing or unreadable, so the drift comparison could not run (fail-closed).`
        : '';
    throw new GeneralError(
      `Refused ${driftCtx.refusals.length} patch(es) whose refreshed body would absorb ` +
        `engine edits not present in the old patch body (--refuse-foreign-drift): ${names}.${unreadablePart}\n\n` +
        'The flag cannot tell WHO wrote those lines, and the two populations have opposite ' +
        'remedies:\n' +
        '  - Lines you added yourself since the last export (the per-file report tags these ' +
        '"edited since your last export"): name them with --expect <path> so this run captures ' +
        'them, or re-run without the flag to capture every drifting file.\n' +
        "  - Lines another session owns: do NOT proceed — commit or stash that session's work " +
        'first, then re-run.'
    );
  }
}

/**
 * Prints the end-of-run summary and enforces the exit contract: a partial run
 * exits non-zero by default. "Re-exported 2 of 3" printing with exit 0 lets a
 * partial refresh ride an `&&` chain as success. The summary still prints
 * first so the honest "N of M" accounting stays visible; the throw then
 * carries the failed/skipped breakdown. Dry-run included: a preview
 * reporting that the real run would partially fail must not read as a passing
 * preview in scripts.
 */
function reportReExportOutcome(args: {
  isDryRun: boolean;
  reExported: number;
  selectedCount: number;
  reExportedFilenames: string[];
  failedFilenames: string[];
  shouldStamp: boolean;
  stampRequested: boolean;
  config: FireForgeConfig;
  progress: SpinnerHandle;
}): void {
  const { isDryRun, reExported, selectedCount, config, progress } = args;
  if (isDryRun) {
    progress.stop('Dry run complete');
    success(`[dry-run] Would re-export ${reExported} of ${selectedCount} patch(es)`);
    if (args.stampRequested) {
      info(
        `[dry-run] Would stamp sourceVersion=${config.firefox.version} (${config.firefox.product}) on ${reExported} patch(es)`
      );
    }
    outro('Dry run complete');
  } else {
    progress.stop('Re-export complete');
    success(`Re-exported ${reExported} of ${selectedCount} patch(es)`);
    if (args.shouldStamp) {
      success(
        `Stamped sourceVersion=${config.firefox.version} (${config.firefox.product}) on ${args.reExportedFilenames.length} patch(es)`
      );
    } else if (args.stampRequested && reExported !== selectedCount) {
      warn(
        '--stamp was requested but some patches failed or were skipped; refusing to stamp a partial set.'
      );
    }
    outro('Re-export complete');
  }

  if (reExported < selectedCount) {
    const skippedCount = selectedCount - reExported - args.failedFilenames.length;
    const failedPart =
      args.failedFilenames.length > 0 ? ` Failed: ${args.failedFilenames.join(', ')}.` : '';
    const skippedPart =
      skippedCount > 0 ? ` Skipped: ${skippedCount} patch(es) (see warnings above).` : '';
    throw new GeneralError(
      `${isDryRun ? '[dry-run] Would re-export' : 'Re-exported'} only ${reExported} of ` +
        `${selectedCount} selected patch(es).${failedPart}${skippedPart} ` +
        'Partial re-export exits non-zero so it cannot pass as success in scripts; ' +
        'the per-patch errors are listed above.'
    );
  }
}
