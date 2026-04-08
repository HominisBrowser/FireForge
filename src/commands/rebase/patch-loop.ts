// SPDX-License-Identifier: EUPL-1.2
/**
 * Patch application loop and re-export flow.
 */

import { join } from 'node:path';

import type { getProjectPaths } from '../../core/config.js';
import { loadState, saveState } from '../../core/config.js';
import { getDiffForFilesAgainstHead } from '../../core/git-diff.js';
import { applyPatchWithFuzz } from '../../core/patch-apply-fuzz.js';
import { updatePatch } from '../../core/patch-export.js';
import { discoverPatches } from '../../core/patch-files.js';
import { loadPatchesManifest, stampPatchVersions } from '../../core/patch-manifest.js';
import { extractConflictingFiles } from '../../core/patch-parse.js';
import type { RebaseSession } from '../../core/rebase-session.js';
import { clearRebaseSession, saveRebaseSession } from '../../core/rebase-session.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, spinner, success, warn } from '../../utils/logger.js';
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

    s.message(`Applying ${entry.filename}...`);

    const result = await applyPatchWithFuzz(patchFile.path, paths.engine, maxFuzz);

    if (result.success) {
      if (result.fuzzFactor === 0) {
        entry.status = 'applied-clean';
        success(`  ${entry.filename} — applied cleanly`);
      } else {
        entry.status = 'applied-fuzz';
        entry.fuzzFactor = result.fuzzFactor;
        warn(`  ${entry.filename} — applied with fuzz=${result.fuzzFactor}`);
      }
      session.currentIndex = i + 1;
      await saveRebaseSession(projectRoot, session);
    } else {
      entry.status = 'failed';
      if (result.error) {
        entry.error = result.error;
      }
      entry.conflictingFiles = extractConflictingFiles(result.error);
      session.currentIndex = i;
      await saveRebaseSession(projectRoot, session);

      // Set pendingResolution in state for visibility
      const state = await loadState(projectRoot);
      state.pendingResolution = {
        patchFilename: entry.filename,
        originalError: result.error ?? 'Unknown error',
      };
      await saveState(projectRoot, state);

      s.error(`${entry.filename} failed to apply`);
      if (result.error) {
        error(`  Error: ${result.error}`);
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

  // Re-export all successfully applied patches
  await reExportAppliedPatches(session, paths);

  // Stamp versions
  const appliedFilenames = session.patches
    .filter(
      (p) => p.status === 'applied-clean' || p.status === 'applied-fuzz' || p.status === 'resolved'
    )
    .map((p) => p.filename);

  if (appliedFilenames.length > 0) {
    await stampPatchVersions(paths.patches, appliedFilenames, session.toVersion);
  }

  // Print summary and clean up
  printSummary(session);
  await clearRebaseSession(projectRoot);

  // Clear pending resolution if any
  const state = await loadState(projectRoot);
  if (state.pendingResolution) {
    delete state.pendingResolution;
    await saveState(projectRoot, state);
  }

  info('');
  success(`All patches re-exported with sourceEsrVersion=${session.toVersion}`);
  outro('Rebase complete!');
}

async function reExportAppliedPatches(
  session: RebaseSession,
  paths: ReturnType<typeof getProjectPaths>
): Promise<void> {
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) return;

  const s = spinner('Re-exporting patches...');

  for (const entry of session.patches) {
    if (entry.status !== 'applied-clean' && entry.status !== 'applied-fuzz') continue;

    const meta = manifest.patches.find((p) => p.filename === entry.filename);
    if (!meta) continue;

    s.message(`Re-exporting ${entry.filename}...`);

    const existingFiles: string[] = [];
    for (const f of meta.filesAffected) {
      if (await pathExists(join(paths.engine, f))) {
        existingFiles.push(f);
      }
    }

    try {
      const diffContent = await getDiffForFilesAgainstHead(paths.engine, existingFiles);
      if (diffContent.trim()) {
        const patchPath = join(paths.patches, entry.filename);
        await updatePatch(patchPath, diffContent);
      }
    } catch (err: unknown) {
      warn(`Failed to re-export ${entry.filename}: ${toError(err).message}`);
    }
  }

  s.stop('Patches re-exported');
}
