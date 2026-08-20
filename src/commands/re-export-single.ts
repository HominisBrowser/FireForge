// SPDX-License-Identifier: EUPL-1.2
/**
 * Single-patch refresh core for `fireforge re-export`, split out of
 * `re-export.ts` (at the per-file line budget after the
 * hoisted-lint and foreign-drift wiring). The orchestrator loop calls
 * {@link reExportSinglePatchWithIndexLockRetry} per selected patch.
 */

import { getProjectPaths } from '../core/config.js';
import { enforceFreshFurnaceSources } from '../core/furnace-stale-export.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import { buildProjectedManifest, enforcePatchPolicy } from '../core/patch-policy.js';
import { isGitIndexLockConflict } from '../errors/git.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { info, success, warn } from '../utils/logger.js';
import type { AdjacentUnmanagedContext } from './re-export-adjacent.js';
import { findMissingFiles, reportAdjacentUnmanagedFiles } from './re-export-adjacent.js';
import type { ForeignDriftContext } from './re-export-drift.js';
import { reportForeignDrift } from './re-export-drift.js';
import {
  lintReExportedPatch,
  type ReExportLintContext,
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

/**
 * Retries a single patch re-export exactly once when the failure is
 * transient git `index.lock` contention (an external git process holding
 * the engine repo's index). The retry re-enters `reExportSinglePatch`
 * from the top, so it re-reads clean state; a second lock failure
 * propagates to the loop's honest "N of M" accounting.
 */
export async function reExportSinglePatchWithIndexLockRetry(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig,
  adjacentCtx: AdjacentUnmanagedContext,
  driftCtx: ForeignDriftContext,
  lintCtx: ReExportLintContext
): Promise<boolean> {
  try {
    return await reExportSinglePatch(
      patch,
      paths,
      manifest,
      options,
      isDryRun,
      config,
      adjacentCtx,
      driftCtx,
      lintCtx
    );
  } catch (error: unknown) {
    if (!isGitIndexLockConflict(error)) {
      throw error;
    }
    warn(
      `${patch.filename}: git index.lock contention detected — retrying once after ${String(GIT_INDEX_LOCK_RETRY_MS)} ms...`
    );
    await new Promise((resolve) => setTimeout(resolve, GIT_INDEX_LOCK_RETRY_MS));
    return await reExportSinglePatch(
      patch,
      paths,
      manifest,
      options,
      isDryRun,
      config,
      adjacentCtx,
      driftCtx,
      lintCtx
    );
  }
}

async function reExportSinglePatch(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig,
  adjacentCtx: AdjacentUnmanagedContext,
  driftCtx: ForeignDriftContext,
  lintCtx: ReExportLintContext
): Promise<boolean> {
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
    // to adopt unmanaged files that import modules created by LATER
    // patches — the after-the-fact lint failure this leaves behind is the
    // field-reported footgun. Applies to broad --scan, --scan-file, and
    // the --scan-files bulk assignments alike.
    await assertScanAdoptionsHaveNoForwardImports({
      patchesDir: paths.patches,
      engineDir: paths.engine,
      patchFilename: patch.filename,
      added: scanResult.added,
    });

    if (options.scanFiles === undefined) {
      const isInteractive = process.stdin.isTTY && process.stdout.isTTY;
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
    // Finding #16: when neither `--scan` nor `--files` is set and some
    // of the manifest's claimed files no longer exist on disk, the
    // re-export silently writes a refreshed body whose filesAffected
    // still names the vanished paths. That is the documented contract,
    // but it is also a footgun — a later `verify` then fails on
    // manifest-consistency with no obvious trigger. Emit one advisory
    // warning up-front when we can detect the drift cheaply, so the
    // operator has a chance to re-run with `--scan` or `--files`
    // before the stale filesAffected lands in patches.json.
    const args = { patch, paths, manifest, currentFilesAffected, ctx: adjacentCtx };
    if (await reportAdjacentUnmanagedFiles(args)) return false;
  }

  // --- Explicit file-subset path ---
  // When --files is given, the target filesAffected is authoritative — drop
  // anything not in the list, add anything new. This is the surgical repair
  // primitive that replaces hand-editing patches.json; the user has already
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

  // Stale-furnace-source gate (0.37.0 item 4): re-export captures deployed
  // engine copies, so a component source edited after the last furnace
  // apply would land in the patch as its OLD deployed content. Refuse (or
  // warn under --allow-stale-furnace) before diffing. Runs in dry-run too
  // so the failure surfaces early.
  await enforceFreshFurnaceSources(
    paths.root,
    currentFilesAffected,
    options.allowStaleFurnace === true,
    're-export'
  );

  const missingFiles = await findMissingFiles(paths.engine, currentFilesAffected);

  if (missingFiles.length === currentFilesAffected.length) {
    warn(`Skipped ${patch.filename}: all affected files missing`);
    warn(`Missing files: ${missingFiles.join(', ')}`);
    return false;
  }

  if (missingFiles.length > 0) {
    warn(`${patch.filename}: missing files will be skipped: ${missingFiles.join(', ')}`);
  }

  const missingSet = new Set(missingFiles);
  const existingFiles = currentFilesAffected.filter((f) => !missingSet.has(f));

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
  // carry — the case where a concurrent session's uncommitted edits in
  // OWNED files would be silently absorbed. Always previews (including
  // dry-run and --scan); refuses only under --refuse-foreign-drift.
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

  // Lint against the ONCE-per-invocation hoisted context (queue context +
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
 * fresh lint result is stored keyed against the just-written body — the
 * state a repeat invocation will observe — and the in-memory
 * manifest row mirrors the on-disk write for later loop iterations
 * (notably `--all --scan`, where `getClaimedFiles` reads this manifest).
 */
async function commitRefreshedPatch(args: {
  patch: PatchMetadata;
  paths: ReturnType<typeof getProjectPaths>;
  manifest: PatchesManifest;
  options: ReExportOptions;
  config: FireForgeConfig;
  lintCtx: ReExportLintContext;
  diffContent: string;
  updates: Partial<PatchMetadata>;
  projectedMetadata: PatchMetadata;
  existingFiles: string[];
  lintResult: Awaited<ReturnType<typeof lintReExportedPatch>>;
}): Promise<void> {
  const { patch, paths, manifest, options, config, lintCtx, diffContent, updates } = args;
  await updatePatchAndMetadata(paths.patches, patch.filename, diffContent, updates, undefined, {
    config,
    command: 're-export',
    forceUnsafe: options.forceUnsafe === true,
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

  success(`Re-exported ${patch.filename}`);
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
 * suppression honoured by export/export-all is also honoured here — a
 * re-export could otherwise not refresh an advisory-noisy but intentional
 * patch without the blunt `--skip-lint`. The paired `patch.tier` threads
 * the explicit branding-threshold opt-in the same way. The CLI flags
 * `--tier` and `--lint-ignore` participate with append/union semantics
 * (explicit removal lives on `fireforge patch lint-ignore`), computed
 * before the lint pass so the new intent takes effect on this invocation.
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
