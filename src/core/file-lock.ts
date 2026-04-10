// SPDX-License-Identifier: EUPL-1.2
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { toError } from '../utils/errors.js';
import { ensureDir } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  staleMs?: number;
  onTimeoutMessage?: string;
  onStaleLockMessage?: (ageMs: number) => string | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function getNodeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

/** Derives the sibling lock-directory path used to guard a file-based resource. */
export function createSiblingLockPath(filePath: string, suffix = '.fireforge.lock'): string {
  return `${filePath}${suffix}`;
}

async function removeIfStaleLock(
  lockPath: string,
  staleMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;
    if (ageMs <= staleMs) {
      return false;
    }

    const staleMessage = onStaleLockMessage?.(ageMs);
    if (staleMessage) {
      warn(staleMessage);
    }

    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT') {
      verbose(`Stale lock disappeared before cleanup completed: ${lockPath}`);
      return true;
    }

    verbose(`Stale lock check failed for ${lockPath}: ${toError(error).message}`);
    throw toError(error);
  }
}

/** Runs an async operation while holding a directory lock, with stale-lock recovery. */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const deadline = Date.now() + timeoutMs;
  let attemptedStaleRecovery = false;

  await ensureDir(dirname(lockPath));

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (error: unknown) {
      const isAlreadyLocked =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string' &&
        error.code === 'EEXIST';

      if (!isAlreadyLocked) {
        throw error;
      }

      if (!attemptedStaleRecovery) {
        attemptedStaleRecovery = true;
        if (await removeIfStaleLock(lockPath, staleMs, options.onStaleLockMessage)) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(
          options.onTimeoutMessage ??
            `Timed out waiting for file lock ${lockPath}. Remove the lock directory if it is stale.`,
          { cause: error }
        );
      }

      await sleep(pollMs);
    }
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
