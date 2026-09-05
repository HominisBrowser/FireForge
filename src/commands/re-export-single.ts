// SPDX-License-Identifier: EUPL-1.2
/**
 * Single-patch refresh core for `fireforge re-export`, split out of
 * `re-export.ts` to stay under the per-file line budget. The orchestrator
 * loop calls {@link reExportSinglePatchWithIndexLockRetry} per selected
 * patch.
 */

import { stdioIsInteractive } from '../core/destructive.js';
import { enforceFreshFurnaceSources } from '../core/furnace-stale-export.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { listTrackedInHead } from '../core/git-file-ops.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import { buildProjectedManifest, enforcePatchPolicy } from '../core/patch-policy.js';
import { isGitIndexLockConflict } from '../errors/git.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { info, success, warn } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import { findMissingFiles, reportAdjacentUnmanagedFiles } from './re-export-adjacent.js';
import type { ForeignDriftContext } from './re-export-drift.js';
import { reportForeignDrift } from './re-export-drift.js';
import {
  lintReExportedPatch,
  type ReExportLintContext,
  type ReExportLintResult,
  refreshQueueCtxEntry,
  storeReExportLintResult,
} from './re-export-lint.js';
import {
  assertScanAdoptionsHaveNoForwardImports,
  assertScanFileAdditionsHaveDiffHunks,
  confirmBroadScanAdditions,
  scanPatchFilesForReExport,
} from './re-export-scan.js';

const GIT_INDEX_LOCK_RETRY_MS = 300;

export interface ReExportSinglePatchArgs {
  /** Manifest row for the patch being refreshed. */
  patch: PatchMetadata;
  /** Resolved project paths. */
  paths: ProjectPaths;
  /** Patch queue manifest as loaded by the orchestrator. */
  manifest: PatchesManifest;
  /** Effective re-export options for this patch. */
  options: ReExportOptions;
  /** Whether the run is a dry run. */
  isDryRun: boolean;
  /** Project configuration. */
  config: FireForgeConfig;
  /** Adjacent-unmanaged-file reporting context. */
  adjacentCtx: AdjacentUnmanagedContext;
  /** Foreign-drift reporting context. */
  driftCtx: ForeignDriftContext;
  /** Per-patch lint context, including the shared lint cache. */
  lintCtx: ReExportLintContext;
}

/**
 * Retries a single patch re-export exactly once when the failure is
 * transient git `index.lock` contention (an external git process holding
 * the engine repo's index). The retry re-enters `reExportSinglePatch`
 * from the top, so it re-reads clean state. A second lock failure
 * propagates to the loop's honest "N of M" accounting.
 */
export async function reExportSinglePatchWithIndexLockRetry(
  args: ReExportSinglePatchArgs
): Promise<boolean> {
  try {
    return await reExportSinglePatch(args);
  } catch (error: unknown) {
    if (!isGitIndexLockConflict(error)) {
      throw error;
    }
    warn(
      `${args.patch.filename}: git index.lock contention detected — retrying once after ${GIT_INDEX_LOCK_RETRY_MS} ms...`
    );
    await sleep(GIT_INDEX_LOCK_RETRY_MS);
    return await reExportSinglePatch(args);
  }
}

async function reExportSinglePatch(args: ReExportSinglePatchArgs): Promise<boolean> {
  const { patch, paths, manifest, options, isDryRun, config, adjacentCtx, driftCtx, lintCtx } =
    args;
  let currentFilesAffected = [...patch.filesAffected];

  // --- Scan for new/removed files ---
  if (options.scan) {
    const scanResult = await scanPatchFilesForReExport({
      currentFilesAffected,
      engineDir: paths.engine,
      manifest,
      patchFilename: patch.filename,
      isDryRun,
      ...(options.scanFiles !== undefined ? { scanFiles: options.scanFiles } : {}),
    });

    // Forward-import gate at adoption time (runs in dry-run too): refuse
    // to adopt unmanaged files that import modules created by later
    // patches, because the after-the-fact lint failure this leaves behind
    // is the field-reported footgun. Applies to broad --scan, --scan-file,
    // and the --scan-files bulk assignments alike.
    await assertScanAdoptionsHaveNoForwardImports({
      patchesDir: paths.patches,
      engineDir: paths.engine,
      patchFilename: patch.filename,
      added: scanResult.added,
    });

    if (options.scanFiles === undefined) {
      const isInteractive = stdioIsInteractive();
      const proceed = await confirmBroadScanAdditions({
        patchFilename: patch.filename,
        added: scanResult.added,
        isDryRun,
        yes: options.yes === true,
        isInteractive,
      });
      if (!proceed) {
        return false;
      }
    }
    currentFilesAffected = scanResult.updated;
  } else if (options.files === undefined) {
    // When neither `--scan` nor `--files` is set and some of the manifest's
    // claimed files no longer exist on disk, the re-export silently writes a
    // refreshed body whose filesAffected still names the vanished paths.
    // That is the documented contract, but it is also a footgun: a later
    // `verify` then fails on manifest-consistency with no obvious trigger.
    // Emit one advisory warning up-front when the drift is cheap to detect,
    // so the operator can re-run with `--scan` or `--files` before the stale
    // filesAffected lands in patches.json.
    const args = { patch, paths, manifest, currentFilesAffected, ctx: adjacentCtx };
    if (await reportAdjacentUnmanagedFiles(args)) return false;
  }

  // --- Explicit file-subset path ---
  // When --files is given, the target filesAffected is authoritative: drop
  // anything not in the list, add anything new. This is the surgical repair
  // primitive that replaces hand-editing patches.json. The user has already
  // acknowledged via confirmDestructive (done in the caller) that any drop
  // is intentional.
  if (options.files !== undefined) {
    const requested = [...new Set(options.files)].sort();
    currentFilesAffected = requested;
    const removed = patch.filesAffected.filter((f) => !requested.includes(f));
    const added = requested.filter((f) => !patch.filesAffected.includes(f));
    for (const f of added) info(`  + ${f}`);
    for (const f of removed) info(`  - ${f}`);
  }

  // Stale-furnace-source gate: re-export captures deployed engine copies, so
  // a component source edited after the last furnace apply would land in the
  // patch as its old deployed content. Refuse (or warn under
  // --allow-stale-furnace) before diffing. Runs in dry-run too so the failure
  // surfaces early.
  await enforceFreshFurnaceSources(
    paths.root,
    currentFilesAffected,
    options.allowStaleFurnace === true,
    're-export'
  );

  const absentFiles = await findMissingFiles(paths.engine, currentFilesAffected);
  // A path absent from disk but tracked in engine HEAD is a deletion, and
  // `git diff HEAD` renders it as a real `deleted file mode` section. Only
  // a never-tracked path has nothing to diff. Skipping both alike meant a
  // retired file quietly left the patch body while staying in its file
  // list, so the patch then claimed a file it could not restore.
  const trackedAbsent = await listTrackedInHead(paths.engine, absentFiles);
  const deletedFiles = absentFiles.filter((f) => trackedAbsent.has(f));
  const untrackedAbsent = absentFiles.filter((f) => !trackedAbsent.has(f));

  if (untrackedAbsent.length === currentFilesAffected.length) {
    warn(`Skipped ${patch.filename}: all affected files missing`);
    warn(`Missing files: ${untrackedAbsent.join(', ')}`);
    return false;
  }

  if (untrackedAbsent.length > 0) {
    warn(`${patch.filename}: missing files will be skipped: ${untrackedAbsent.join(', ')}`);
  }
  if (deletedFiles.length > 0) {
    info(`${patch.filename}: capturing deletion of ${deletedFiles.join(', ')}`);
  }

  const untrackedSet = new Set(untrackedAbsent);
  const existingFiles = currentFilesAffected.filter((f) => !untrackedSet.has(f));

  const diffContent = await getDiffForFilesAgainstHead(paths.engine, existingFiles);
  assertScanFileAdditionsHaveDiffHunks({
    diffContent,
    patchFilename: patch.filename,
    previousFilesAffected: patch.filesAffected,
    scanFiles: options.scanFiles,
  });

  if (!diffContent.trim()) {
    warn(`Skipped ${patch.filename}: no changes (files unchanged from HEAD)`);
    return false;
  }

  // Foreign-drift preview + optional hard stop: show which
  // payload lines are about to enter the body that the old body did not
  // carry, the case where a concurrent session's uncommitted edits in
  // owned files would be silently absorbed. Always previews (including
  // dry-run and --scan). Refuses only under --refuse-foreign-drift.
  if (
    await reportForeignDrift({
      patch,
      patchesDir: paths.patches,
      engineDir: paths.engine,
      newDiffContent: diffContent,
      ctx: driftCtx,
    })
  ) {
    return false;
  }

  const { updates, ignoreChecks, effectiveTier, existingIgnoreSet, flagIgnoreSet } =
    computeReExportUpdates(patch, options, currentFilesAffected);

  enforcePatchPolicy({
    config,
    manifest: buildProjectedManifest(
      manifest,
      manifest.patches.map((entry) =>
        entry.filename === patch.filename ? { ...entry, ...updates } : entry
      )
    ),
    command: 're-export',
    forceUnsafe: options.forceUnsafe === true,
  });

  // Lint against the once-per-invocation hoisted context (queue context +
  // queue-wide checkJs program + per-patch result cache) instead of
  // rebuilding ~37 s of setup for every patch in the loop.
  const projectedMetadata = { ...patch, ...updates };
  const lintResult = await lintReExportedPatch({
    lintCtx,
    patch,
    projectedMetadata,
    existingFiles,
    diffContent,
    ...(options.skipLint !== undefined ? { skipLint: options.skipLint } : {}),
    ...(ignoreChecks !== undefined ? { ignoreChecks } : {}),
    ...(effectiveTier !== undefined ? { patchTier: effectiveTier } : {}),
  });

  if (isDryRun) {
    info(`[dry-run] ${patch.filename}: ${existingFiles.length} file(s)`);
    if (effectiveTier !== undefined && effectiveTier !== patch.tier) {
      info(`[dry-run] ${patch.filename}: tier would become ${effectiveTier}`);
    }
    const addedIgnores = [...flagIgnoreSet].filter((id) => !existingIgnoreSet.has(id));
    if (addedIgnores.length > 0) {
      info(`[dry-run] ${patch.filename}: lintIgnore would gain ${addedIgnores.join(', ')}`);
    }
  } else {
    await commitRefreshedPatch({
      patch,
      paths,
      manifest,
      options,
      config,
      lintCtx,
      diffContent,
      updates,
      projectedMetadata,
      existingFiles,
      lintResult,
    });
  }
  return true;
}

/**
 * Writes the refreshed body + manifest row atomically under the patch
 * directory lock (a split write would let a concurrent queue mutation
 * leave body and `filesAffected` disagreeing), then keeps the run's
 * in-memory state honest: the queue context entry is refreshed and the
 * fresh lint result is stored keyed against the just-written body (the
 * state a repeat invocation will observe), and the in-memory
 * manifest row mirrors the on-disk write for later loop iterations
 * (notably `--all --scan`, where `getClaimedFiles` reads this manifest).
 */
async function commitRefreshedPatch(args: {
  patch: PatchMetadata;
  paths: ProjectPaths;
  manifest: PatchesManifest;
  options: ReExportOptions;
  config: FireForgeConfig;
  lintCtx: ReExportLintContext;
  diffContent: string;
  updates: Partial<PatchMetadata>;
  projectedMetadata: PatchMetadata;
  existingFiles: string[];
  lintResult: ReExportLintResult | null;
}): Promise<void> {
  const { patch, paths, manifest, options, config, lintCtx, diffContent, updates } = args;
  const bodyChanged = await updatePatchAndMetadata({
    patchesDir: paths.patches,
    filename: patch.filename,
    newContent: diffContent,
    updates,
    onCommitted: undefined,
    policyGate: {
      config,
      command: 're-export',
      forceUnsafe: options.forceUnsafe === true,
    },
  });

  refreshQueueCtxEntry(lintCtx, patch.filename, diffContent);
  if (args.lintResult !== null) {
    await storeReExportLintResult(
      lintCtx,
      patch.filename,
      args.projectedMetadata,
      args.existingFiles,
      args.lintResult
    );
  }

  const patchIndex = manifest.patches.findIndex((pm) => pm.filename === patch.filename);
  if (patchIndex !== -1) {
    const existingEntry = manifest.patches[patchIndex];
    if (existingEntry) {
      manifest.patches[patchIndex] = {
        ...existingEntry,
        ...updates,
      };
    }
  }

  // A bulk run refreshes every patch. Saying "Re-exported" for one whose body
  // did not move buries the patches that did move. The run still counts this
  // patch as successfully refreshed, so `--stamp` completeness is unaffected.
  if (bodyChanged) {
    success(`Re-exported ${patch.filename}`);
  } else {
    info(`Unchanged ${patch.filename}`);
  }
}

/** The projected metadata + lint inputs for one patch's refresh. */
interface ReExportUpdatePlan {
  updates: Partial<PatchMetadata>;
  ignoreChecks: Set<string> | undefined;
  effectiveTier: 'branding' | undefined;
  existingIgnoreSet: Set<string>;
  flagIgnoreSet: Set<string>;
}

/**
 * Threads the patch's own `lintIgnore` list through so the per-patch
 * suppression honoured by export/export-all is also honoured here. A
 * re-export could otherwise not refresh an advisory-noisy but intentional
 * patch without the blunt `--skip-lint`. The paired `patch.tier` threads the
 * explicit branding-threshold opt-in the same way. The CLI flags `--tier`
 * and `--lint-ignore` participate with append/union semantics (explicit
 * removal lives on `fireforge patch lint-ignore`), computed before the lint
 * pass so the new intent takes effect on this invocation.
 */
function computeReExportUpdates(
  patch: PatchMetadata,
  options: ReExportOptions,
  currentFilesAffected: string[]
): ReExportUpdatePlan {
  const existingIgnoreSet = new Set<string>(patch.lintIgnore ?? []);
  const flagIgnoreSet = new Set<string>(options.lintIgnore ?? []);
  const mergedIgnoreSet = new Set<string>([...existingIgnoreSet, ...flagIgnoreSet]);
  const effectiveLintIgnore = mergedIgnoreSet.size > 0 ? [...mergedIgnoreSet] : undefined;
  const updates: Partial<PatchMetadata> = {
    filesAffected: currentFilesAffected,
  };
  if (options.tier !== undefined) {
    updates.tier = options.tier;
  }
  if (effectiveLintIgnore !== undefined && flagIgnoreSet.size > 0) {
    updates.lintIgnore = effectiveLintIgnore;
  }
  return {
    updates,
    ignoreChecks: effectiveLintIgnore ? new Set<string>(effectiveLintIgnore) : undefined,
    effectiveTier: options.tier ?? patch.tier,
    existingIgnoreSet,
    flagIgnoreSet,
  };
}
