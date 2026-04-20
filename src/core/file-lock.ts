// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

const LOCK_PID_FILE = 'pid';

/**
 * Checks whether a process with the given PID is still running.
 * Uses `kill(pid, 0)` which sends no signal but checks existence.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function removeIfStaleLock(
  lockPath: string,
  staleMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;

    // Check PID FIRST, independent of age. Before this ordering change the
    // function age-gated everything: a lock younger than `staleMs` (default
    // 5 minutes) was never removed even when its PID file pointed at a
    // process that had already exited. That's the exact situation an
    // operator lands in after SIGINT'ing `furnace preview` — the signal
    // handler calls `process.exit`, `withFileLock`'s `finally { rm }`
    // never runs, and the next command has to either wait 5 minutes for
    // the staleness gate or manually remove the lock directory. With the
    // PID-first check, an explicitly-dead owner unblocks immediately.
    const pidCheck = await readLockOwnerPid(lockPath);
    if (pidCheck.present) {
      if (!isProcessAlive(pidCheck.pid)) {
        const staleMessage = onStaleLockMessage?.(ageMs);
        if (staleMessage) {
          warn(staleMessage);
        } else {
          verbose(
            `Lock at ${lockPath} owner PID ${pidCheck.pid} is no longer running — removing (age: ${Math.round(ageMs / 1000)}s)`
          );
        }
        await rm(lockPath, { recursive: true, force: true });
        return true;
      }
      // PID is alive — respect it regardless of age. A slow `mach build`
      // legitimately holds the lock past the stale threshold and we don't
      // want to race-remove it.
      verbose(
        `Lock at ${lockPath} is ${Math.round(ageMs / 1000)}s old but PID ${pidCheck.pid} is still running — not removing`
      );
      return false;
    }

    // No readable PID file. Fall back to the age-only heuristic so locks
    // written by earlier FireForge releases (which may not have written a
    // PID file) still clear after the staleness window elapses.
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

/**
 * Reads the owner PID from a lock directory's PID file. Returns `{ present:
 * false }` when the PID file is missing or the content does not parse as a
 * finite integer (caller falls back to the age-only staleness heuristic).
 */
async function readLockOwnerPid(
  lockPath: string
): Promise<{ present: false } | { present: true; pid: number }> {
  try {
    const pidContent = await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8');
    const pid = parseInt(pidContent.trim(), 10);
    if (Number.isFinite(pid)) {
      return { present: true, pid };
    }
  } catch {
    // PID file missing or unreadable — treat as absent.
  }
  return { present: false };
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

  // Write PID into the lock directory so stale-lock recovery can check
  // whether the owning process is still alive before removing.
  try {
    await writeFile(join(lockPath, LOCK_PID_FILE), String(process.pid), 'utf-8');
  } catch {
    // Non-fatal: stale recovery falls back to age-only heuristic
  }

  try {
    return await operation();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
