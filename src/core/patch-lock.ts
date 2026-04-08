// SPDX-License-Identifier: EUPL-1.2
/**
 * Filesystem-based lock for serializing patch directory mutations.
 */

import { join } from 'node:path';

import { PatchError } from '../errors/patch.js';
import { toError } from '../utils/errors.js';
import { withFileLock } from './file-lock.js';

const PATCH_DIRECTORY_LOCK = '.fireforge-patches.lock';

/**
 * Runs a patch directory mutation while holding an exclusive filesystem lock.
 * This serializes filename allocation and manifest writes across parallel exports.
 */
export async function withPatchDirectoryLock<T>(
  patchesDir: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockDir = join(patchesDir, PATCH_DIRECTORY_LOCK);
  return withFileLock(lockDir, operation, {
    onTimeoutMessage:
      `Timed out waiting for another patch export to finish in ${patchesDir}.\n` +
      `If no other fireforge process is running, the lock may be stale. ` +
      `Remove it manually:\n  rm -rf "${lockDir}"`,
    onStaleLockMessage: (ageMs) =>
      `Removing stale patch lock (age: ${Math.round(ageMs / 1000)}s). ` +
      'A previous fireforge process may have crashed.',
  }).catch((error: unknown) => {
    if (error instanceof PatchError) {
      throw error;
    }

    throw new PatchError(toError(error).message);
  });
}
