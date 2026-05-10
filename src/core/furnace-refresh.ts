// SPDX-License-Identifier: EUPL-1.2
/**
 * Three-way merge logic for refreshing overrides against a newer Firefox baseline.
 *
 * When Firefox moves forward and an override's `baseVersion` drifts, the user
 * needs a way to incorporate upstream changes into their override workspace
 * without losing local modifications. This module uses `git merge-file` to
 * perform a three-way merge between the old baseline, the current override,
 * and the new upstream content.
 */
import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import { readText, writeText } from '../utils/fs.js';
import { exec } from '../utils/process.js';
import { ensureGit } from './git-base.js';
import { getFileContentAtRef } from './git-file-ops.js';

export interface RefreshFileResult {
  fileName: string;
  status: 'merged' | 'conflict' | 'unchanged' | 'new-file';
  conflictMarkers?: number;
}

function isFatalMergeStderr(stderr: string): boolean {
  return /(?:^|\n)\s*(?:fatal|error):/i.test(stderr);
}

function classifyMergeFileResult(result: { exitCode: number; stderr: string }): number {
  if (result.exitCode === 0 && !isFatalMergeStderr(result.stderr)) {
    return 0;
  }

  if (result.exitCode >= 1 && result.exitCode <= 127 && !isFatalMergeStderr(result.stderr)) {
    return result.exitCode;
  }

  const detail = result.stderr.trim() || `exit code ${result.exitCode}`;
  throw new FurnaceError(`git merge-file failed: ${detail}`);
}

/**
 * Performs a three-way merge on a single file.
 *
 * Uses `git merge-file` with:
 *   - base: the original Firefox content at the override's recorded baseCommit
 *   - ours: the current override workspace content (local modifications)
 *   - theirs: the current Firefox content at HEAD
 *
 * @returns The merged content and the number of conflict markers (0 = clean merge)
 */
async function threeWayMergeFile(
  base: string,
  ours: string,
  theirs: string,
  label: { base: string; ours: string; theirs: string },
  strategy?: 'ours' | 'theirs'
): Promise<{ merged: string; conflicts: number }> {
  await ensureGit();

  // Write all three versions to temp files for git merge-file.
  // Use crypto.randomUUID() for unique, unpredictable temp file names.
  const id = randomUUID();
  const tempBase = join(tmpdir(), `fireforge-merge-base-${id}`);
  const tempOurs = join(tmpdir(), `fireforge-merge-ours-${id}`);
  const tempTheirs = join(tmpdir(), `fireforge-merge-theirs-${id}`);

  try {
    await writeText(tempBase, base);
    await writeText(tempOurs, ours);
    await writeText(tempTheirs, theirs);

    // git merge-file writes the result to the first file (ours) in-place.
    // Exit code 0 = clean merge, 1..127 = conflict count, shell-exposed
    // fatal errors typically arrive as >=128 (for example, 255).
    const mergeArgs = [
      'merge-file',
      ...(strategy ? [`--${strategy}`] : []),
      '-L',
      label.ours,
      '-L',
      label.base,
      '-L',
      label.theirs,
      tempOurs,
      tempBase,
      tempTheirs,
    ];
    const result = await exec('git', mergeArgs);
    const conflicts = classifyMergeFileResult(result);
    const merged = await readText(tempOurs);

    return { merged, conflicts };
  } finally {
    // Clean up temp files (best-effort)
    await Promise.allSettled([unlink(tempBase), unlink(tempOurs), unlink(tempTheirs)]);
  }
}

/**
 * Refreshes a single override file against the current engine HEAD.
 *
 * @param engineDir - Path to the engine git repository
 * @param overridePath - Path to the current override file in the workspace
 * @param engineRelPath - Engine-relative path for git show
 * @param baseCommit - The git ref at which the override was originally created
 * @param fileName - Display name for the file
 * @returns Merge result with the updated content written to the override file
 */
export async function refreshOverrideFile(
  engineDir: string,
  overridePath: string,
  engineRelPath: string,
  baseCommit: string,
  fileName: string,
  dryRun?: boolean,
  strategy?: 'ours' | 'theirs'
): Promise<RefreshFileResult> {
  // Read the three versions
  const oursContent = await readText(overridePath);

  const baseContent = await getFileContentAtRef(engineDir, engineRelPath, baseCommit);
  if (baseContent === null) {
    // File didn't exist at baseCommit — this is a new file introduced by the override
    return { fileName, status: 'new-file' };
  }

  const theirsContent = await getFileContentAtRef(engineDir, engineRelPath, 'HEAD');
  if (theirsContent === null) {
    // File was removed upstream — no merge needed, keep the override as-is
    return { fileName, status: 'unchanged' };
  }

  // If upstream hasn't changed, nothing to merge
  if (baseContent === theirsContent) {
    return { fileName, status: 'unchanged' };
  }

  // If our override matches the base (no local changes), just take theirs
  if (oursContent === baseContent) {
    if (!dryRun) {
      await writeText(overridePath, theirsContent);
    }
    return { fileName, status: 'merged' };
  }

  // Three-way merge
  const { merged, conflicts } = await threeWayMergeFile(
    baseContent,
    oursContent,
    theirsContent,
    {
      ours: `components/overrides/${fileName} (your changes)`,
      base: `Firefox ${baseCommit.slice(0, 8)} (original)`,
      theirs: `Firefox HEAD (upstream)`,
    },
    strategy
  );

  if (!dryRun) {
    await writeText(overridePath, merged);
  }

  if (conflicts > 0) {
    return { fileName, status: 'conflict', conflictMarkers: conflicts };
  }

  return { fileName, status: 'merged' };
}
