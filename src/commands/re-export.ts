// SPDX-License-Identifier: EUPL-1.2
import { multiselect } from '@clack/prompts';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { collectFurnaceManagedPrefixes } from '../core/furnace-config.js';
import { isGitRepository } from '../core/git.js';
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
import { pathExists } from '../utils/fs.js';
import { cancel, info, intro, isCancel, outro, spinner, success, warn } from '../utils/logger.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import {
  loadScanFilesAssignments,
  withDryRunPurityGuard,
  withDryRunReExportLock,
} from './re-export-bulk-scan.js';
import type { ForeignDriftContext } from './re-export-drift.js';
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
        const available = manifest.patches.map((p) => p.filename).join(', ');
        throw new InvalidArgumentError(
          `Patch "${identifier}" not found in manifest.\n\nAvailable patches: ${available}`,
          identifier
        );
      }
      selectedPatches.push(match);
    }
    return selectedPatches;
  }

  // No patches specified — prompt or error
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

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
  // path-shaped extra positionals into the file list (0.34.0 field report).
  ({ patches, options } = applyReExportFilesPositionalFolding(patches, options));

  validateReExportOptionCombinations(patches, options);

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Check if it's a git repository
  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

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
  // once for the whole run (FORGE G2).
  const adjacentCtx: AdjacentUnmanagedContext = {
    binaryName: config.binaryName,
    furnacePrefixes: await collectFurnaceManagedPrefixes(paths.root),
    refuseAdjacentUnmanaged: options.refuseAdjacentUnmanaged === true,
    refusals: [],
  };

  const driftCtx = buildForeignDriftContext(options);

  // Hoisted lint context, one per run (FORGE J1): queue context + checkJs
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
          const exported = await reExportSinglePatchWithIndexLockRetry(
            patch,
            paths,
            manifest,
            patchOptions,
            isDryRun,
            config,
            adjacentCtx,
            driftCtx,
            lintCtx
          );
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
 * Foreign-drift guard context, one per run (FORGE J2). `--expect` paths
 * (FORGE L6) are normalized once here so the per-patch comparison matches
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
 * Names `--expect` paths that never drifted this run (FORGE L6). A typo'd
 * `--expect` path silently degrades the flag back to refusing the slice it
 * was meant to admit, so surface the mismatch — but only as a warning: an
 * expected file legitimately shows no drift when the slice was already
 * captured by an earlier export.
 */
function warnUnseenExpectedDrift(driftCtx: ForeignDriftContext): void {
  const unseen = [...driftCtx.expectedDriftFiles].filter(
    (file) => !driftCtx.expectedSeen.has(file)
  );
  if (unseen.length === 0) return;
  if (driftCtx.evaluationRuns === 0) {
    warn(
      `--expect path(s) were not evaluated because no selected patch reached the drift check (for example, an earlier refusal): ${unseen.join(', ')}`
    );
    return;
  }
  warn(
    `--expect path(s) showed no drift this run (typo, or already captured?): ${unseen.join(', ')}`
  );
}

/**
 * Turns the run's collected `--refuse-adjacent-unmanaged` (FORGE G2) and
 * `--refuse-foreign-drift` (FORGE J2) refusals into the non-zero exit,
 * naming every refused patch and the remedy.
 */
function throwRunLevelRefusals(
  adjacentCtx: AdjacentUnmanagedContext,
  driftCtx: ForeignDriftContext,
  progress: ReturnType<typeof spinner>
): void {
  if (adjacentCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    const names = adjacentCtx.refusals.map((r) => r.patchFilename).join(', ');
    throw new GeneralError(
      `Refused ${String(adjacentCtx.refusals.length)} patch(es) with adjacent unmanaged files ` +
        `(--refuse-adjacent-unmanaged): ${names}. Adopt reviewed files with --scan --scan-file, ` +
        `or export them as a new patch.`
    );
  }

  if (driftCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    const names = driftCtx.refusals.map((r) => r.patchFilename).join(', ');
    const unreadable = driftCtx.refusals.filter((r) => r.reason === 'baseline-unreadable');
    const unreadablePart =
      unreadable.length > 0
        ? ` ${String(unreadable.length)} of these refused because the old patch body was missing or unreadable, so the drift comparison could not run (fail-closed).`
        : '';
    throw new GeneralError(
      `Refused ${String(driftCtx.refusals.length)} patch(es) whose refreshed body would absorb ` +
        `engine edits not present in the old patch body (--refuse-foreign-drift): ${names}.${unreadablePart} ` +
        `Commit or stash the foreign edits (another session may own them), name the slice's ` +
        `intended files with --expect <path>, or re-run without the flag to capture them intentionally.`
    );
  }
}

/**
 * Prints the end-of-run summary and enforces the FORGE H8 exit contract:
 * a partial run exits non-zero BY DEFAULT (adjudicated for 0.41.0, per the
 * follow-up 0.40.0's G7 recorded). "Re-exported 2 of 3" used to print and
 * exit 0, letting a partial refresh ride an `&&` chain as success. The
 * summary still prints first so the honest "N of M" accounting stays
 * visible; the throw then carries the failed/skipped breakdown. Dry-run
 * included: a preview reporting that the real run would partially fail
 * must not read as a passing preview in scripts.
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
  progress: ReturnType<typeof spinner>;
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
      skippedCount > 0 ? ` Skipped: ${String(skippedCount)} patch(es) (see warnings above).` : '';
    throw new GeneralError(
      `${isDryRun ? '[dry-run] Would re-export' : 'Re-exported'} only ${String(reExported)} of ` +
        `${String(selectedCount)} selected patch(es).${failedPart}${skippedPart} ` +
        'Partial re-export exits non-zero so it cannot pass as success in scripts; ' +
        'the per-patch errors are listed above.'
    );
  }
}
