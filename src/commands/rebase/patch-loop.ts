// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch application loop and re-export flow.
 */

import { join } from 'node:path';

import type { getProjectPaths } from '../../core/config.js';
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
import { clearRebaseSession, saveRebaseSession } from '../../core/rebase-session.js';
import { runInSignalCriticalSection } from '../../core/signal-critical.js';
import { RebaseError } from '../../errors/rebase.js';
import { elapsedSince } from '../../utils/elapsed.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, spinner, success, warn } from '../../utils/logger.js';
import { buildRebaseConflictSummary } from './conflict-summary.js';
import { printSummary } from './summary.js';

/**
 * Runs the patch application loop, re-exports applied patches, and stamps versions.
 */
export async function runPatchLoop(
  projectRoot: string,
  session: RebaseSession,
  paths: ReturnType<typeof getProjectPaths>,
  maxFuzz: number
): Promise<void> {
  const allPatches = await discoverPatches(paths.patches);

  const s = spinner('Applying patches...');

  for (let i = session.currentIndex; i < session.patches.length; i++) {
    const entry = session.patches[i];
    if (!entry) continue;
    const patchFile = allPatches.find((p) => p.filename === entry.filename);

    if (!patchFile) {
      warn(`Patch file not found for ${entry.filename}, skipping.`);
      entry.status = 'skipped';
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

      if (applyResult.success) {
        if (applyResult.fuzzFactor === 0) {
          entry.status = 'applied-clean';
        } else {
          entry.status = 'applied-fuzz';
          entry.fuzzFactor = applyResult.fuzzFactor;
        }
        session.currentIndex = i + 1;
        await saveRebaseSession(projectRoot, session);
      } else {
        entry.status = 'failed';
        if (applyResult.error) {
          entry.error = applyResult.error;
        }
        entry.conflictingFiles = extractConflictingFiles(applyResult.error);
        session.currentIndex = i;
        await saveRebaseSession(projectRoot, session);
      }

      return applyResult;
    });

    if (result.success) {
      if (result.fuzzFactor === 0) {
        success(`  ${entry.filename} — applied cleanly`);
      } else {
        warn(`  ${entry.filename} — applied with fuzz=${result.fuzzFactor}`);
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
  const reExportFailures = await reExportAppliedPatches(session, paths);
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

  // Stamp versions
  const appliedFilenames = session.patches
    .filter(
      (p) => p.status === 'applied-clean' || p.status === 'applied-fuzz' || p.status === 'resolved'
    )
    .map((p) => p.filename);

  if (appliedFilenames.length > 0) {
    await stampPatchVersions(paths.patches, appliedFilenames, session.toVersion);
  }

  // Stamp every Furnace override's `baseVersion` to match the rebased
  // Firefox version. Before this stamp, a successful ESR bump left
  // overrides in a doctor-failing drift state (each override still
  // claimed the pre-rebase ESR as its baseline) and every subsequent
  // `fireforge doctor` failed `Furnace component validation`. The
  // stamp is unconditional per the helper's contract: rebase already
  // succeeded on the patch side, so the operator is committing to the
  // new ESR baseline; per-component health checking stays with
  // `fireforge furnace validate` / `doctor --repair-furnace`.
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
  await updateState(projectRoot, (current) => {
    if (!current.pendingResolution) return current;
    const next = { ...current };
    delete next.pendingResolution;
    return next;
  });

  info('');
  success(`All patches re-exported with sourceEsrVersion=${session.toVersion}`);
  outro('Rebase complete!');
}

async function reExportAppliedPatches(
  session: RebaseSession,
  paths: ReturnType<typeof getProjectPaths>
): Promise<Array<{ filename: string; error: string }>> {
  const failures: Array<{ filename: string; error: string }> = [];

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) return failures;

  const s = spinner('Re-exporting patches...');

  const reExportable = session.patches.filter(
    (entry) => entry.status === 'applied-clean' || entry.status === 'applied-fuzz'
  );
  const startedAt = Date.now();

  for (const [index, entry] of reExportable.entries()) {
    const meta = manifest.patches.find((p) => p.filename === entry.filename);
    if (!meta) continue;

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
        await withPatchDirectoryLock(paths.patches, () => updatePatch(patchPath, diffContent));
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

  return failures;
}
