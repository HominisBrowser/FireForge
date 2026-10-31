// SPDX-License-Identifier: EUPL-1.2
/**
 * Stale-state cleanup for mach's own dev profile, `tmp/profile-default` in
 * each `obj-*` directory.
 *
 * `fireforge run` cleans it before every launch, and `fireforge build --ui`
 * drops its startup cache after the build, because a UI build keeps the
 * build id the startup cache is keyed on.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, removeDir, removeFile } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';

/** What {@link cleanDevProfile} removes besides the startup cache. */
export interface DevProfileCleanupOptions {
  /**
   * Also remove a leftover `.parentlock`. Only a caller about to launch the
   * browser may: the lock of a browser that is still running must stay.
   */
  removeParentLock: boolean;
}

/**
 * Cleans the dev profile of every `obj-*` directory to prevent stale-state
 * startup failures.
 *
 * Removes:
 * 1. `startupCache/`: Firefox caches compiled chrome JS bytecode here,
 *    keyed on the build id. When chrome scripts change between builds that
 *    keep the build id, the stale cache serves the old scripts or crashes
 *    the startup silently.
 * 2. `.parentlock`, with `removeParentLock`: a zero-byte lock file that
 *    persists if the previous session was killed (Ctrl-C, crash, `kill`).
 *    Firefox checks this on startup and silently exits if it exists,
 *    assuming another instance owns the profile.
 *
 * Failures are non-fatal and only logged in verbose mode.
 * @param engineDir - Path to the engine directory
 * @param options - Whether the `.parentlock` goes too
 * @returns The number of startup caches removed
 */
export async function cleanDevProfile(
  engineDir: string,
  options: DevProfileCleanupOptions
): Promise<number> {
  let removedCaches = 0;
  try {
    const entries = await readdir(engineDir);
    const objDirs = entries.filter((e) => e.startsWith('obj-'));

    for (const objDir of objDirs) {
      const profileDir = join(engineDir, objDir, 'tmp', 'profile-default');

      const cachePath = join(profileDir, 'startupCache');
      if (await pathExists(cachePath)) {
        await removeDir(cachePath);
        removedCaches += 1;
      }

      if (!options.removeParentLock) continue;
      const lockPath = join(profileDir, '.parentlock');
      if (await pathExists(lockPath)) {
        await removeFile(lockPath);
      }
    }
  } catch (error: unknown) {
    verbose(`Non-fatal dev profile cleanup failure: ${toError(error).message}`);
  }
  return removedCaches;
}
