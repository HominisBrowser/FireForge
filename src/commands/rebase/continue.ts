// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase --continue flow.
 */

import { join } from 'node:path';

import { getProjectPaths, loadState, saveState } from '../../core/config.js';
import { getStagedDiffForFiles } from '../../core/git-diff.js';
import { stageFiles, unstageFiles } from '../../core/git-file-ops.js';
import { updatePatch, updatePatchMetadata } from '../../core/patch-export.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { loadRebaseSession, saveRebaseSession } from '../../core/rebase-session.js';
import { GeneralError } from '../../errors/base.js';
import { NoRebaseSessionError, RebaseError } from '../../errors/rebase.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, success, warn } from '../../utils/logger.js';
import { runPatchLoop } from './patch-loop.js';

/**
 * Handles `fireforge rebase --continue`.
 */
export async function handleContinue(projectRoot: string, maxFuzz: number): Promise<void> {
  intro('FireForge Rebase — Continue');

  const session = await loadRebaseSession(projectRoot);
  if (!session) throw new NoRebaseSessionError();

  const paths = getProjectPaths(projectRoot);

  // The current patch should be in 'failed' state
  const currentPatch = session.patches[session.currentIndex];
  if (!currentPatch || currentPatch.status !== 'failed') {
    throw new RebaseError(
      'Expected the current patch to be in a failed state. The session may be corrupt.'
    );
  }

  info(`Resolving: ${currentPatch.filename}`);

  // Look up the patch's files from the manifest
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) throw new GeneralError('Patches manifest not found.');

  const meta = manifest.patches.find((p) => p.filename === currentPatch.filename);
  if (!meta) throw new GeneralError(`Patch ${currentPatch.filename} not found in manifest.`);

  // Re-export the resolved patch from current engine state
  const activeFiles: string[] = [];
  for (const f of meta.filesAffected) {
    if (await pathExists(join(paths.engine, f))) {
      activeFiles.push(f);
    }
  }

  let staged = false;
  try {
    await stageFiles(paths.engine, activeFiles);
    staged = true;
    const diffContent = await getStagedDiffForFiles(paths.engine, activeFiles);

    if (!diffContent.trim()) {
      warn('No diff generated — the files may not have changed from HEAD.');
      warn(
        'Either apply your fixes and re-run --continue, or skip this patch (not yet supported).'
      );
      return;
    }

    const patchPath = join(paths.patches, currentPatch.filename);
    await updatePatch(patchPath, diffContent);
    await updatePatchMetadata(paths.patches, currentPatch.filename, {
      sourceEsrVersion: session.toVersion,
    });
  } finally {
    if (staged) {
      await unstageFiles(paths.engine, activeFiles);
    }
  }

  // Mark resolved and advance
  currentPatch.status = 'resolved';
  session.currentIndex++;
  await saveRebaseSession(projectRoot, session);

  // Clear pending resolution
  const state = await loadState(projectRoot);
  if (state.pendingResolution) {
    delete state.pendingResolution;
    await saveState(projectRoot, state);
  }

  success(`Resolved ${currentPatch.filename}`);

  // Continue applying remaining patches
  await runPatchLoop(projectRoot, session, paths, maxFuzz);
}
