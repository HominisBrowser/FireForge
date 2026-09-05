// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch application loop and re-export flow.
 */

import { join } from 'node:path';

import { updateState } from '../../core/config.js';
import { stampFurnaceOverrideBaseVersions } from '../../core/furnace-config.js';
import { getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import { applyPatchWithFuzz } from '../../core/patch-apply-fuzz.js';
import { updatePatch } from '../../core/patch-export.js';
import { discoverPatches } from '../../core/patch-files.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import { loadPatchesManifest, stampPatchVersions } from '../../core/patch-manifest.js';
import { extractConflictingFiles } from '../../core/patch-parse.js';
import type { RebaseSession } from '../../core/rebase-session.js';
import {
  clearRebaseSession,
  type RebasePatchEntry,
  saveRebaseSession,
} from '../../core/rebase-session.js';
import { runInSignalCriticalSection } from '../../core/signal-critical.js';
import { RebaseError } from '../../errors/rebase.js';
import type { ProjectPaths } from '../../types/config.js';
import { elapsedSince } from '../../utils/elapsed.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, spinner, success, warn } from '../../utils/logger.js';
import { isValidFirefoxVersion } from '../../utils/validation.js';
import { clearPendingResolution } from '../pending-resolution.js';
import { buildRebaseConflictSummary } from './conflict-summary.js';
import { printSummary } from './summary.js';

/**
 * Builds the session entry for a patch-apply outcome.
 *
 * Constructing a whole entry rather than assigning fields is what the
 * discriminated union buys: a status can never be flipped while the previous
 * status's payload stays behind, which is how
 * `{ status: 'resolved', error, conflictingFiles }` reaches the session file.
 *
 * @param filename - Patch filename the entry describes
 * @param applyResult - Outcome from `applyPatchWithFuzz`
 * @returns The entry to store at this patch's index
 */
function entryForApplyResult(
  filename: string,
  applyResult: { success: boolean; fuzzFactor?: number; error?: string }
): RebasePatchEntry {
  if (!applyResult.success) {
    return {
      filename,
      status: 'failed',
      ...(applyResult.error !== undefined ? { error: applyResult.error } : {}),
      conflictingFiles: extractConflictingFiles(applyResult.error),
    };
  }
  if (applyResult.fuzzFactor === 0 || applyResult.fuzzFactor === undefined) {
    return { filename, status: 'applied-clean' };
  }
  return { filename, status: 'applied-fuzz', fuzzFactor: applyResult.fuzzFactor };
}

/**
 * Runs the patch application loop, re-exports applied patches, and stamps versions.
 *
 * @param projectRoot - Project root directory
 * @param session - The active rebase session, mutated and persisted as it runs
 * @param paths - Resolved project paths
 * @param maxFuzz - Maximum context-reduction steps for `git apply -C<n>`
 * @param waitLockSeconds - `--wait-lock` budget for the patch-directory lock
 */
export async function runPatchLoop(
  projectRoot: string,
  session: RebaseSession,
  paths: ProjectPaths,
  maxFuzz: number,
  waitLockSeconds?: number
): Promise<void> {
  const allPatches = await discoverPatches(paths.patches);

  const s = spinner('Applying patches...');

  for (let i = session.currentIndex; i < session.patches.length; i++) {
    const entry = session.patches[i];
    if (!entry) continue;
    const patchFile = allPatches.find((p) => p.filename === entry.filename);

    if (!patchFile) {
      warn(`Patch file not found for ${entry.filename}, skipping.`);
      // Replaced, not mutated: the entry is a discriminated union, so a status
      // change is a new value rather than a field assignment. That is what
      // stops a status flip stranding the previous status's payload.
      session.patches[i] = { filename: entry.filename, status: 'skipped' };
      session.currentIndex = i + 1;
      await saveRebaseSession(projectRoot, session);
      continue;
    }

    s.message(`Applying ${i + 1}/${session.patches.length}: ${entry.filename}...`);

    // Apply + session persist is wrapped in a signal-deferred critical
    // section so a SIGINT / SIGTERM between the filesystem mutation and
    // the session-file update is held until the bookkeeping write lands.
    // Without this guard, `rebase --continue` could see a patch that is
    // already in the engine but still marked pending, and would re-apply
    // it on resume (either failing on duplicate hunks or producing
    // divergent results).
    const result = await runInSignalCriticalSection(`rebase-apply:${entry.filename}`, async () => {
      const applyResult = await applyPatchWithFuzz(patchFile.path, paths.engine, maxFuzz);
      session.patches[i] = entryForApplyResult(entry.filename, applyResult);
      session.currentIndex = applyResult.success ? i + 1 : i;
      await saveRebaseSession(projectRoot, session);
      return applyResult;
    });

    if (result.success) {
      if (result.fuzzFactor === 0) {
        success(`  ${entry.filename} — applied cleanly`);
      } else {
        warn(`  ${entry.filename} — applied with context reduction (step ${result.fuzzFactor})`);
      }
    } else {
      // Set pendingResolution in state for visibility. Kept outside the
      // critical section — it is advisory UX, not a correctness invariant,
      // and its absence would at most cause `fireforge status` to omit the
      // pending-conflict hint until the next state write.
      await updateState(projectRoot, (current) => ({
        ...current,
        pendingResolution: {
          patchFilename: entry.filename,
          originalError: result.error ?? 'Unknown error',
        },
      }));

      s.error(`${entry.filename} failed to apply`);
      const summary = buildRebaseConflictSummary({
        patchFilename: entry.filename,
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.rejectFiles !== undefined ? { rejectFiles: result.rejectFiles } : {}),
      });
      warn(`Conflict summary for ${summary.patchFilename}: ${summary.category}`);
      if (summary.failedFiles.length > 0) {
        warn(`  Failed files: ${summary.failedFiles.join(', ')}`);
      } else {
        warn('  Failed files: not detected from git output');
      }
      info('  Suggested next commands:');
      for (const command of summary.nextCommands) {
        info(`    ${command}`);
      }
      if (result.error) {
        error(`  Raw apply detail: ${result.error}`);
      }
      if (result.rejectFiles && result.rejectFiles.length > 0) {
        info(`  .rej files created for manual resolution`);
      }
      info('');
      info('Resolution instructions:');
      info('  1. Manually fix the conflicts in engine/ (look for .rej files)');
      info('  2. Run "fireforge rebase --continue" to resume');
      info('  3. Or run "fireforge rebase --abort" to cancel the rebase');

      return; // Stop the loop
    }
  }

  s.stop('All patches applied');

  // Re-export all successfully applied patches. Failures here mean the
  // engine has been rebased onto the new Firefox version but some .patch
  // files were not refreshed — the queue would lie about what version each
  // patch was tested against if we proceeded to stamp. Refuse to claim
  // success and leave the session in place so the user can recover via
  // `fireforge rebase --continue` after fixing the underlying cause.
  const { failures: reExportFailures, overlapSkipped } = await reExportAppliedPatches(
    session,
    paths,
    waitLockSeconds
  );
  if (reExportFailures.length > 0) {
    for (const f of reExportFailures) {
      error(`  ${f.filename}: ${f.error}`);
    }
    throw new RebaseError(
      `Apply succeeded but ${reExportFailures.length} patch(es) failed to re-export. ` +
        `Versions were not stamped and the rebase session has been kept so you can retry. ` +
        `Fix the underlying cause shown above, then re-run "fireforge rebase --continue".`
    );
  }

  if (overlapSkipped.length > 0) {
    warn(
      `${overlapSkipped.length} patch(es) share files with other patches and were NOT ` +
        `re-exported or version-stamped: ${overlapSkipped.join(', ')}. Their .patch files ` +
        `still describe the pre-rebase source. Re-export them manually (e.g. ` +
        `"fireforge re-export") and verify the overlapping hunks before the next import.`
    );
  }

  // Stamp versions — only for patches whose .patch file now actually
  // reflects the new source (overlap-skipped ones keep their old stamp so
  // the queue does not lie about what each patch was tested against).
  const overlapSkippedSet = new Set(overlapSkipped);
  const appliedFilenames = session.patches
    .filter(
      (p) => p.status === 'applied-clean' || p.status === 'applied-fuzz' || p.status === 'resolved'
    )
    .map((p) => p.filename)
    .filter((filename) => !overlapSkippedSet.has(filename));

  if (appliedFilenames.length > 0) {
    await stampPatchVersions(paths.patches, appliedFilenames, session.toVersion, session.toProduct);
  }

  // Stamp every Furnace override's `baseVersion` to match the rebased
  // Firefox source version. Without it, a successful source bump leaves
  // overrides in a doctor-failing drift state — each still claiming the
  // pre-rebase source as its baseline — and every subsequent
  // `fireforge doctor` fails `Furnace component validation`. The stamp is
  // unconditional per the helper's contract: rebase already succeeded on
  // the patch side, so the operator is committing to the new source
  // baseline; per-component health checking stays with
  // `fireforge furnace validate` / `doctor --repair-furnace`.
  //
  // "Unconditional" means unconditional on component health, not on the
  // value: `stampFurnaceOverrideBaseVersions` assigns and persists whatever
  // string it is handed, so a session whose `toVersion` is not a real
  // Firefox version would rewrite every override's baseline to that value.
  // `isValidSession` rejects such a session at read time; this refuses to
  // persist it even if a future caller reaches here another way.
  if (!isValidFirefoxVersion(session.toVersion)) {
    throw new RebaseError(
      `Refusing to stamp Furnace override baseVersion(s): the rebase session's target version ` +
        `("${session.toVersion}") is not a valid Firefox version.`
    );
  }
  try {
    const overridesStamped = await stampFurnaceOverrideBaseVersions(projectRoot, session.toVersion);
    if (overridesStamped > 0) {
      info(`Stamped ${overridesStamped} Furnace override baseVersion(s) to ${session.toVersion}.`);
    }
  } catch (furnaceStampError: unknown) {
    warn(
      `Could not stamp Furnace override baseVersion(s) to ${session.toVersion}: ${toError(furnaceStampError).message}. Update baseVersion in furnace.json by hand or run "fireforge furnace refresh" if validate reports drift.`
    );
  }

  // Print summary and clean up
  printSummary(session);
  await clearRebaseSession(projectRoot);

  // Clear pending resolution if any (transactionally, so a concurrent
  // state write to an unrelated key is not clobbered by a stale reload).
  await clearPendingResolution(projectRoot);

  info('');
  success(`All patches re-exported with sourceVersion=${session.toVersion}`);
  outro('Rebase complete!');
}

async function reExportAppliedPatches(
  session: RebaseSession,
  paths: ProjectPaths,
  waitLockSeconds: number | undefined
): Promise<{
  failures: Array<{ filename: string; error: string }>;
  overlapSkipped: string[];
}> {
  const failures: Array<{ filename: string; error: string }> = [];
  const overlapSkipped: string[] = [];

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) return { failures, overlapSkipped };

  // Re-export writes `getDiffForFilesAgainstHead(files)` — the CUMULATIVE
  // diff of those files. For a file claimed by two patches (a supported
  // `--allow-overlap` queue), that diff contains BOTH patches' hunks, so
  // rewriting each patch with it would duplicate the shared file's hunks
  // into every owner: the very next import then fails or silently
  // double-materialises. Refuse to auto-re-export any patch whose files
  // overlap another patch; the operator re-exports those manually where
  // per-patch attribution is possible.
  const fileOwners = new Map<string, number>();
  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) {
      fileOwners.set(file, (fileOwners.get(file) ?? 0) + 1);
    }
  }

  const s = spinner('Re-exporting patches...');

  const reExportable = session.patches.filter(
    (entry) => entry.status === 'applied-clean' || entry.status === 'applied-fuzz'
  );
  const startedAt = Date.now();

  for (const [index, entry] of reExportable.entries()) {
    const meta = manifest.patches.find((p) => p.filename === entry.filename);
    if (!meta) continue;

    const sharedFiles = meta.filesAffected.filter((f) => (fileOwners.get(f) ?? 0) > 1);
    if (sharedFiles.length > 0) {
      overlapSkipped.push(entry.filename);
      warn(
        `Skipping re-export of ${entry.filename}: file(s) shared with other patches ` +
          `(${sharedFiles.join(', ')}). Re-export it manually once the overlap is resolved.`
      );
      continue;
    }

    const existingFiles: string[] = [];
    for (const f of meta.filesAffected) {
      if (await pathExists(join(paths.engine, f))) {
        existingFiles.push(f);
      }
    }
    s.message(
      `Re-exporting ${index + 1}/${reExportable.length}: ${entry.filename} (${existingFiles.length}/${meta.filesAffected.length} file(s), ${elapsedSince(startedAt)} elapsed)...`
    );

    try {
      const diffContent = await getDiffForFilesAgainstHead(paths.engine, existingFiles);
      if (diffContent.trim()) {
        const patchPath = join(paths.patches, entry.filename);
        // Hold the patch directory lock for the body rewrite so a concurrent
        // manifest-mutating command (`resolve`, `re-export`, `patch compact`,
        // `patch reorder`) cannot observe a torn patch body mid-write or
        // persist metadata describing a body this loop is about to overwrite.
        // Rebase sessions are serialized against each other by
        // `rebase-session.ts`, so this lock is only defending against other
        // command classes, not peer rebases.
        await withPatchDirectoryLock(paths.patches, () => updatePatch(patchPath, diffContent), {
          waitLockSeconds,
          command: 'rebase',
        });
      }
    } catch (err: unknown) {
      const message = toError(err).message;
      warn(`Failed to re-export ${entry.filename}: ${message}`);
      failures.push({ filename: entry.filename, error: message });
    }
  }

  if (failures.length > 0) {
    s.error(`Re-export failed for ${failures.length} patch(es)`);
  } else {
    s.stop('Patches re-exported');
  }

  return { failures, overlapSkipped };
}
