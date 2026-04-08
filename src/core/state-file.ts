// SPDX-License-Identifier: EUPL-1.2
import { rename } from 'node:fs/promises';
import { basename } from 'node:path';

import { pathExists } from '../utils/fs.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';

/** Runs an operation while holding the sidecar lock for a FireForge state file. */
export async function withStateFileLock<T>(
  statePath: string,
  operation: () => Promise<T>
): Promise<T> {
  return withFileLock(createSiblingLockPath(statePath, '.fireforge-state.lock'), operation, {
    onTimeoutMessage:
      `Timed out waiting to update FireForge state at ${statePath}. ` +
      'If no other fireforge process is running, remove the stale lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge state lock for ${basename(statePath)} ` +
      `(age: ${Math.round(ageMs / 1000)}s). A previous fireforge process may have crashed.`,
  });
}

/** Renames a state file out of the way while preserving it for later inspection. */
export async function quarantineStateFile(
  statePath: string,
  reason = 'corrupt'
): Promise<string | undefined> {
  if (!(await pathExists(statePath))) {
    return undefined;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const quarantinedPath = `${statePath}.${reason}-${timestamp}`;
  await rename(statePath, quarantinedPath);
  return basename(quarantinedPath);
}
