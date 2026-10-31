// SPDX-License-Identifier: EUPL-1.2
/**
 * The per-patch loop of `fireforge re-export`.
 *
 * Without `--refuse-foreign-drift` each selected patch is prepared and
 * committed in turn, so one patch's refusal or failure leaves the others
 * written. Under the flag every selected patch is prepared (scanned,
 * diffed and judged for drift, nothing written) before any is committed,
 * and a drift refusal anywhere writes none: a multi-patch export is the
 * unit the operator reviewed, and half of it written is a queue state
 * nobody asked for.
 */

import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import { elapsedSince } from '../utils/elapsed.js';
import { toError } from '../utils/errors.js';
import { type SpinnerHandle, warn } from '../utils/logger.js';
import { scanOptionsForPatch } from './re-export-scan-owner.js';
import {
  commitPreparedPatchWithIndexLockRetry,
  type PreparedReExport,
  prepareSinglePatchWithIndexLockRetry,
  type ReExportSinglePatchArgs,
  reExportSinglePatchWithIndexLockRetry,
} from './re-export-single.js';

/** Inputs of the per-patch loop. */
export interface ReExportEachArgs {
  /** The selected patches, in queue order. */
  selectedPatches: readonly PatchMetadata[];
  /** The run's options. */
  options: ReExportOptions;
  /** Per-patch scan-file assignments, when the run names any. */
  scanAssignments: ReadonlyMap<string, string[]> | undefined;
  /** The run's progress line. */
  progress: SpinnerHandle;
  /** When the run started, for the elapsed time in the progress line. */
  startedAt: number;
  /** The arguments every patch's refresh shares. */
  shared: Omit<ReExportSinglePatchArgs, 'patch' | 'options'>;
}

/** What the loop did with each selected patch. */
export interface ReExportEachOutcome {
  /** Patches written (or, in a dry run, that would be). */
  written: string[];
  /** Patches whose refresh threw. */
  failed: string[];
  /** Patches prepared cleanly but not written because another was refused. */
  heldBack: string[];
}

function progressLine(
  verb: string,
  args: ReExportEachArgs,
  position: string,
  patch: PatchMetadata
): string {
  return (
    `${verb} ${position}: ${patch.filename} ` +
    `(${patch.filesAffected.length} file(s), ${elapsedSince(args.startedAt)} elapsed)...`
  );
}

function reportFailure(patch: PatchMetadata, error: unknown, failed: string[]): void {
  failed.push(patch.filename);
  warn(`Failed to re-export ${patch.filename}`);
  warn(toError(error).message);
}

/**
 * Refreshes the selected patches, collecting which wrote, which failed and
 * which were held back.
 *
 * @param args - See {@link ReExportEachArgs}
 * @returns The outcome per patch
 */
export async function reExportEach(args: ReExportEachArgs): Promise<ReExportEachOutcome> {
  if (args.shared.driftCtx.refuseForeignDrift) return reExportJudgedFirst(args);
  const { selectedPatches, options, scanAssignments, progress, shared } = args;
  const written: string[] = [];
  const failed: string[] = [];
  for (const [index, patch] of selectedPatches.entries()) {
    const patchOptions = scanOptionsForPatch(options, patch.filename, scanAssignments);
    progress.message(
      progressLine('Re-exporting', args, `${index + 1}/${selectedPatches.length}`, patch)
    );
    try {
      if (
        await reExportSinglePatchWithIndexLockRetry({ ...shared, patch, options: patchOptions })
      ) {
        written.push(patch.filename);
      }
    } catch (error: unknown) {
      reportFailure(patch, error, failed);
    }
  }
  return { written, failed, heldBack: [] };
}

/**
 * The `--refuse-foreign-drift` loop: prepares every patch, then commits
 * them in queue order only when no patch was refused for drift.
 *
 * A patch's prepare reads the manifest's ownership (which files a scan may
 * adopt, which neighbours are unmanaged), and in the per-patch loop an
 * earlier patch's commit has already moved its row by then. The prepares
 * here run against a copy of the manifest that takes each prepared row's
 * `filesAffected` the way that commit would, so every patch is judged
 * against the ownership it would meet in the per-patch loop. A dry run
 * leaves the manifest alone in either loop, so the copy is left alone too.
 */
async function reExportJudgedFirst(args: ReExportEachArgs): Promise<ReExportEachOutcome> {
  const { selectedPatches, options, scanAssignments, progress, shared } = args;
  const judged: PatchesManifest = { ...shared.manifest, patches: [...shared.manifest.patches] };
  const failed: string[] = [];
  const prepared: { args: ReExportSinglePatchArgs; ready: PreparedReExport }[] = [];
  for (const [index, patch] of selectedPatches.entries()) {
    const patchArgs = {
      ...shared,
      patch,
      options: scanOptionsForPatch(options, patch.filename, scanAssignments),
    };
    progress.message(
      progressLine('Judging', args, `${index + 1}/${selectedPatches.length}`, patch)
    );
    try {
      const ready = await prepareSinglePatchWithIndexLockRetry({ ...patchArgs, manifest: judged });
      if (ready === undefined) continue;
      prepared.push({ args: patchArgs, ready });
      if (!shared.isDryRun) {
        judged.patches = judged.patches.map((entry) =>
          entry.filename === patch.filename
            ? { ...entry, filesAffected: ready.currentFilesAffected }
            : entry
        );
      }
    } catch (error: unknown) {
      reportFailure(patch, error, failed);
    }
  }

  if (shared.driftCtx.refusals.length > 0) {
    return { written: [], failed, heldBack: prepared.map((entry) => entry.args.patch.filename) };
  }

  const written: string[] = [];
  for (const [index, entry] of prepared.entries()) {
    const { patch } = entry.args;
    progress.message(progressLine('Re-exporting', args, `${index + 1}/${prepared.length}`, patch));
    try {
      if (await commitPreparedPatchWithIndexLockRetry(entry.args, entry.ready)) {
        written.push(patch.filename);
      }
    } catch (error: unknown) {
      reportFailure(patch, error, failed);
    }
  }
  return { written, failed, heldBack: [] };
}
