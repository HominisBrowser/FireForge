// SPDX-License-Identifier: EUPL-1.2
/**
 * Rebase --continue flow.
 */

import { join } from 'node:path';

import { getProjectPaths, updateState } from '../../core/config.js';
import { getStagedDiffForFiles } from '../../core/git-diff.js';
import { stageFiles, unstageFiles } from '../../core/git-file-ops.js';
import { updatePatchAndMetadata } from '../../core/patch-export.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import {
  getRebaseSessionPath,
  readRebaseSession,
  saveRebaseSession,
} from '../../core/rebase-session.js';
import { runInSignalCriticalSection } from '../../core/signal-critical.js';
import { GeneralError } from '../../errors/base.js';
import {
  CorruptRebaseSessionError,
  NoRebaseSessionError,
  RebaseError,
} from '../../errors/rebase.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, success, warn } from '../../utils/logger.js';
import { runPatchLoop } from './patch-loop.js';

/**
 * Handles `fireforge rebase --continue`.
 */
export async function handleContinue(
  projectRoot: string,
  maxFuzz: number,
  waitLockSeconds?: number
): Promise<void> {
  intro('FireForge Rebase — Continue');

  // A present-but-unreadable session is NOT "no session in progress" — that
  // conflation is what made a corrupt file unrecoverable. Name the file and
  // point at --abort, which can now clear it.
  const read = await readRebaseSession(projectRoot);
  if (!read.present) throw new NoRebaseSessionError();
  if (!read.valid) {
    throw new CorruptRebaseSessionError(getRebaseSessionPath(projectRoot), read.reason);
  }
  const session = read.session;

  const paths = getProjectPaths(projectRoot);

  // Special case: every patch has already applied but a previous run failed
  // somewhere in the post-apply work (re-export, version stamping). In that
  // state currentIndex is past the end of the queue; jumping straight back
  // into runPatchLoop replays the no-op apply loop and re-attempts the
  // post-apply pipeline. Without this branch the user would be stuck —
  // there is no failed patch to resolve, but the session is still active.
  if (session.currentIndex >= session.patches.length) {
    info('All patches already applied; retrying post-apply re-export and version stamping.');
    await runPatchLoop(projectRoot, session, paths, maxFuzz, waitLockSeconds);
    return;
  }

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

    // Write the patch body and the manifest metadata atomically under the
    // shared patch-directory lock. A lock-free updatePatch +
    // updatePatchMetadata sequence can interleave with a concurrent export /
    // re-export / patch reorder / patch compact and leave the manifest
    // disagreeing with the freshly-written patch body. Mirrors resolve.ts.
    await updatePatchAndMetadata(paths.patches, currentPatch.filename, diffContent, {
      sourceEsrVersion: session.toVersion,
      sourceVersion: session.toVersion,
      ...(session.toProduct !== undefined ? { sourceProduct: session.toProduct } : {}),
    });
  } finally {
    if (staged) {
      await unstageFiles(paths.engine, activeFiles);
    }
  }

  // Mark resolved and advance. Wrap in a signal-deferred critical section
  // so SIGINT / SIGTERM between the session update and the pendingResolution
  // clear is held until both writes land, matching the guarantee the apply
  // loop in patch-loop.ts provides.
  await runInSignalCriticalSection(`rebase-continue:${currentPatch.filename}`, async () => {
    // Replaced, not mutated: flipping `status` in place leaves the
    // failure's `error` and `conflictingFiles` on a now-resolved entry, and
    // persist that to the session file. The union makes it impossible.
    session.patches[session.currentIndex] = {
      filename: currentPatch.filename,
      status: 'resolved',
    };
    session.currentIndex++;
    await saveRebaseSession(projectRoot, session);

    // Clear pending resolution transactionally so concurrent state-file
    // writes to unrelated keys are not clobbered by a stale reload.
    await updateState(projectRoot, (current) => {
      if (!current.pendingResolution) return current;
      const next = { ...current };
      delete next.pendingResolution;
      return next;
    });
  });

  success(`Resolved ${currentPatch.filename}`);

  // Continue applying remaining patches
  await runPatchLoop(projectRoot, session, paths, maxFuzz, waitLockSeconds);
}
