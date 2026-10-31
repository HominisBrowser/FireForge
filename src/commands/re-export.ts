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
import type { PerRunCheckJs } from './lint-per-run-checkjs.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import {
  ADJACENT_MEANS,
  buildAdjacentUnmanagedContext,
  reportAdjacentCarveOutUsage,
} from './re-export-adjacent.js';
import {
  loadScanFilesAssignments,
  withDryRunPurityGuard,
  withDryRunReExportLock,
} from './re-export-bulk-scan.js';
import type { ForeignDriftContext } from './re-export-drift.js';
import { warnUnseenExpectedDrift } from './re-export-drift.js';
import { reExportEach } from './re-export-each.js';
import { reExportFilesInPlace } from './re-export-files.js';
import { buildReExportLintContext, finishReExportLint } from './re-export-lint.js';
import {
  applyReExportFilesPositionalFolding,
  validateReExportOptionCombinations,
} from './re-export-options.js';
import { validateExpectedRemovals } from './re-export-removed.js';
import { dropRetiredPathDeclarations } from './re-export-retired-declarations.js';
import { normalizeEngineRelativeInput, normalizeScanFiles } from './re-export-scan.js';
import { assignScanFileOwners } from './re-export-scan-owner.js';
import { formatCheckJsProjectPassNote, formatReExportRunSummary } from './re-export-summary.js';

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
        // Suggest close matches instead of dumping the queue: a wrong guess
        // would otherwise print the whole ~300-entry manifest, burying the
        // error it was reporting.
        throw new InvalidArgumentError(
          formatPatchNotFoundError(identifier, manifest.patches),
          identifier
        );
      }
      selectedPatches.push(match);
    }
    return selectedPatches;
  }

  // No patches specified: prompt or error
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
 * The patches a `--scan-files` run refreshes: those its manifest names plus
 * the positional patches, once each, in queue order. A positional the
 * manifest does not name has no assigned files and refreshes scan-less.
 * @param scanFilesByPatch - The manifest's assignments, keyed by patch filename
 * @param patches - Positional patch identifiers
 * @param options - Re-export options
 * @param manifest - The patch queue
 */
async function selectScanFilesPatches(
  scanFilesByPatch: ReadonlyMap<string, string[]>,
  patches: string[],
  options: ReExportOptions,
  manifest: PatchesManifest
): Promise<PatchMetadata[]> {
  const positional =
    patches.length > 0 ? ((await resolveSelectedPatches(patches, options, manifest)) ?? []) : [];
  const wanted = new Set([
    ...scanFilesByPatch.keys(),
    ...positional.map((patch) => patch.filename),
  ]);
  return manifest.patches.filter((patch) => wanted.has(patch.filename));
}

/** Lists what a `--scan-files` run adopts into each selected patch. */
function reportScanFilesAssignments(
  manifestPath: string | undefined,
  selectedPatches: readonly PatchMetadata[],
  scanFilesByPatch: ReadonlyMap<string, string[]>
): void {
  info(`Bulk scan assignments from ${manifestPath}`);
  for (const patch of selectedPatches) {
    const files = scanFilesByPatch.get(patch.filename);
    if (files === undefined) {
      info(`  ${patch.filename} (positional, refreshed without a scan)`);
      continue;
    }
    info(`  ${patch.filename} <= ${files.length} file(s)`);
    for (const file of files) info(`    + ${file}`);
  }
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
  // The banner says which mode is in force: a path flag that swallowed
  // `--dry-run` as its value once turned a preview into a write unnoticed.
  intro(isDryRun ? 'FireForge Re-export (DRY RUN)' : 'FireForge Re-export (WRITING)');

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
      ? await selectScanFilesPatches(scanFilesByPatch, patches, options, manifest)
      : await resolveSelectedPatches(patches, options, manifest);
  if (!selectedPatches) return;
  const scanAssignments =
    scanFilesByPatch ?? assignScanFileOwners(options.scanFiles, selectedPatches, manifest);

  if (selectedPatches.length === 0) {
    warn('No patches selected');
    outro('Nothing to re-export');
    return;
  }

  const expectedRemovals = await validateExpectedRemovals(
    paths,
    selectedPatches,
    options,
    manifest.patches
  );
  if (expectedRemovals.length > 0) options = { ...options, expectRemoved: expectedRemovals };

  if (scanFilesByPatch !== undefined) {
    reportScanFilesAssignments(options.scanFilesManifest, selectedPatches, scanFilesByPatch);
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
      withDryRunPurityGuard(
        paths.engine,
        paths.patches,
        isDryRun,
        () => reExportFilesInPlace(paths, selectedPatches, options, filesConfig),
        { patches: selectedPatches }
      )
    );
    return;
  }

  const config = await loadConfig(projectRoot);

  // Classification inputs for the scan-less adjacency advisory, computed
  // once for the whole run.
  const adjacentCtx = buildAdjacentUnmanagedContext(
    options,
    config.binaryName,
    await collectFurnaceManagedPrefixes(paths.root)
  );

  const driftCtx = buildForeignDriftContext(options);

  // Hoisted lint context, one per run: queue context + checkJs
  // program + per-patch result cache, shared across every loop iteration.
  // Taken before the context build, so the elapsed time the progress line
  // reports includes it.
  const startedAt = Date.now();
  const lintCtx = await buildReExportLintContext(
    projectRoot,
    paths,
    config,
    options.noCache === true,
    new Set(selectedPatches.map((patch) => patch.filename))
  );

  const progress = spinner('Preparing re-export...');
  const outcome = await withDryRunReExportLock(paths.fireforgeDir, isDryRun, () =>
    withDryRunPurityGuard(
      paths.engine,
      paths.patches,
      isDryRun,
      () =>
        reExportEach({
          selectedPatches,
          options,
          scanAssignments,
          progress,
          startedAt,
          shared: { paths, manifest, isDryRun, config, adjacentCtx, driftCtx, lintCtx },
        }),
      { patches: selectedPatches }
    )
  );
  const reExportedFilenames = outcome.written;
  const failedFilenames = outcome.failed;
  const reExported = reExportedFilenames.length;

  await finishReExportLint(lintCtx);
  warnUnseenExpectedDrift(driftCtx);
  warnUnseenApprovedUnmanaged(adjacentCtx);
  const summary = formatReExportRunSummary({
    selected: selectedPatches.map((patch) => patch.filename),
    written: reExportedFilenames,
    failed: failedFilenames,
    refusedAdjacent: adjacentCtx.refusals.map((r) => r.patchFilename),
    refusedDrift: driftCtx.refusals.map((r) => r.patchFilename),
    heldBack: outcome.heldBack,
    isDryRun,
  });
  if (summary !== undefined) info(summary);
  const checkJsNote = formatCheckJsProjectPassNote(
    checkJsWrittenPatches(lintCtx.checkJs, selectedPatches, reExportedFilenames),
    isDryRun
  );
  if (checkJsNote !== undefined) info(checkJsNote);
  throwRunLevelRefusals(adjacentCtx, driftCtx, progress, outcome.heldBack);

  if (reExported === 0 && selectedPatches.length > 0) {
    progress.error('Re-export failed');
    throw new GeneralError('All selected patches failed to re-export. Check the errors above.');
  }

  // Declarations on a path this run retired can never be met; drop them
  // now rather than leave them for the next per-patch lint to report.
  await dropRetiredPathDeclarations({ paths, manifest, options, selectedPatches, isDryRun });

  // `--stamp` only fires on a run where every selected patch refreshed
  // cleanly. A partial success would leave some patches with a stale body
  // but a new version, the opposite of the "what I tested, what the
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
    selectedFilenames: selectedPatches.map((patch) => patch.filename),
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
 * admit, and reads as an approval that is in force when it is not.
 * A warning rather than a refusal: an approved path legitimately goes unmet
 * when the reviewed file has since been adopted into a patch, which is the
 * outcome the carve-out exists to be retired by. The `--expect-new` and
 * `--adjacent-ignore` accounting is reported first, alongside.
 */
function warnUnseenApprovedUnmanaged(adjacentCtx: AdjacentUnmanagedContext): void {
  reportAdjacentCarveOutUsage(adjacentCtx);
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
 * The written patches whose files per-patch checkJs type-checks: a
 * checkJs-relevant file among those the patch creates or names.
 */
function checkJsWrittenPatches(
  checkJs: PerRunCheckJs | undefined,
  selectedPatches: readonly PatchMetadata[],
  written: readonly string[]
): string[] {
  if (checkJs === undefined) return [];
  const writtenSet = new Set(written);
  return selectedPatches
    .filter(
      (patch) =>
        writtenSet.has(patch.filename) &&
        (checkJs.ownedByPatch.has(patch.filename) ||
          patch.filesAffected.some((file) => checkJs.isRelevant(file)))
    )
    .map((patch) => patch.filename);
}

/**
 * Turns the run's collected `--refuse-adjacent-unmanaged` and
 * `--refuse-foreign-drift` refusals into the non-zero exit,
 * naming every refused patch, the patches a drift refusal held back
 * unwritten, and the remedy.
 */
function throwRunLevelRefusals(
  adjacentCtx: AdjacentUnmanagedContext,
  driftCtx: ForeignDriftContext,
  progress: SpinnerHandle,
  heldBack: readonly string[]
): void {
  if (adjacentCtx.refusals.length > 0) {
    progress.error('Re-export refused');
    // Each offender is named with the owned directory (or registering
    // carrier) that made it adjacent: an unattended run reads only this
    // line, and without the anchor it cannot tell which of a
    // multi-directory patch's locations the file belongs to.
    const offenders = adjacentCtx.refusals
      .map((r) => `${r.patchFilename} (${r.anchored.join(', ')})`)
      .join('; ');
    throw new GeneralError(
      `Refused ${adjacentCtx.refusals.length} patch(es) with adjacent unmanaged files ` +
        `(--refuse-adjacent-unmanaged): ${offenders}. ${ADJACENT_MEANS} ` +
        `Adopt reviewed files with --scan --scan-file, or export them as a new patch ` +
        `(name a file your next export adopts with --expect-new, and a reviewed, deliberately ` +
        `unmanaged file with --expect-unmanaged or --adjacent-ignore).`
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
    // Under the flag every patch is judged before any is written, so a
    // refusal holds back the patches that were clean.
    const heldBackPart =
      heldBack.length > 0
        ? ` Nothing was written: the run judges every selected patch before writing any, so ` +
          `${heldBack.join(', ')} ${heldBack.length === 1 ? 'was' : 'were'} held back as well.`
        : '';
    throw new GeneralError(
      `Refused ${driftCtx.refusals.length} patch(es) whose refreshed body would add or drop ` +
        `lines relative to the old patch body (--refuse-foreign-drift): ${names}.${unreadablePart}${heldBackPart}\n\n` +
        'The flag cannot tell WHO wrote those lines, and the two populations have opposite ' +
        'remedies:\n' +
        '  - Lines you changed yourself since the last export (the per-file report tags these ' +
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
 * first so the honest "N of M" accounting stays visible. The throw then
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
  selectedFilenames: string[];
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
    const failedPart =
      args.failedFilenames.length > 0 ? ` Failed: ${args.failedFilenames.join(', ')}.` : '';
    const accounted = new Set([...args.reExportedFilenames, ...args.failedFilenames]);
    const skipped = args.selectedFilenames.filter((name) => !accounted.has(name));
    const skippedPart =
      skipped.length > 0 ? ` Skipped: ${skipped.join(', ')} (see warnings above).` : '';
    throw new GeneralError(
      `${isDryRun ? '[dry-run] Would re-export' : 'Re-exported'} only ${reExported} of ` +
        `${selectedCount} selected patch(es).${failedPart}${skippedPart} ` +
        'Partial re-export exits non-zero so it cannot pass as success in scripts; ' +
        'the per-patch errors are listed above.'
    );
  }
}
