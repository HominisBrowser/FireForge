// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { info } from '../utils/logger.js';
import type { LockHolder } from './file-lock.js';
import { withFileLock } from './file-lock.js';
import { git } from './git-base.js';

const ENGINE_SESSION_LOCK_PATH = join('.fireforge', 'engine-session.lock');

export interface EngineSessionLockOptions {
  /**
   * Wait up to this many seconds for the engine session lock instead of the
   * legacy ~1 s fail-fast. Enables exponential poll backoff (100 ms → 2 s)
   * and a holder-identified progress line roughly every 5 s. `undefined`
   * preserves the historical fail-fast behavior exactly.
   */
  waitLockSeconds?: number | undefined;
}

/**
 * Formats the periodic operator-facing waiting line printed while `--wait-lock`
 * polls a contended engine session lock. The holder identification comes from
 * the lock's owner-metadata lines (`command=…`, `started=…`); an unreadable
 * owner file degrades to the anonymous form.
 */
function formatWaitProgressLine(
  waitedMs: number,
  timeoutMs: number,
  holder: LockHolder | undefined
): string {
  const progress = `${String(Math.round(waitedMs / 1000))}s of up to ${String(Math.round(timeoutMs / 1000))}s`;
  if (holder === undefined) {
    return `Waiting for the FireForge engine lock — ${progress}.`;
  }
  const details = holder.metadata.length > 0 ? ` (${holder.metadata.join(', ')})` : '';
  return `Waiting for the FireForge engine lock held by PID ${String(holder.pid)}${details} — ${progress}.`;
}

/**
 *
 */
export async function withEngineSessionLock<T>(
  projectRoot: string,
  command: string,
  operation: () => Promise<T>,
  options: EngineSessionLockOptions = {}
): Promise<T> {
  if (
    process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] !== '1' &&
    (process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined)
  ) {
    return operation();
  }
  const { waitLockSeconds } = options;
  return withFileLock(join(projectRoot, ENGINE_SESSION_LOCK_PATH), operation, {
    timeoutMs: waitLockSeconds !== undefined ? waitLockSeconds * 1000 : 1000,
    ...(waitLockSeconds !== undefined
      ? {
          pollMs: 100,
          pollMaxMs: 2000,
          waitProgressMs: 5000,
          onWaitProgress: ({ waitedMs, timeoutMs, holder }): void => {
            info(formatWaitProgressLine(waitedMs, timeoutMs, holder));
          },
        }
      : {}),
    ownerMetadata: [`command=${command}`, `started=${new Date().toISOString()}`],
    onTimeoutMessage:
      `Another FireForge engine-mutating command is already running. ` +
      `Wait for it to finish, then retry \`${command}\`.`,
    onStaleLockMessage: (ageMs) =>
      `Removed stale FireForge engine session lock (${Math.round(ageMs / 1000)}s old).`,
  });
}

/**
 *
 */
export async function snapshotEngineGeneration(engineDir: string): Promise<string> {
  try {
    const head = (await git(['rev-parse', 'HEAD'], engineDir)).trim();
    const status = await git(['status', '--porcelain=v1', '-z'], engineDir);
    return `${head}\0${status}`;
  } catch (error: unknown) {
    return `unavailable:${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 *
 */
export async function assertEngineGenerationUnchanged(
  engineDir: string,
  before: string
): Promise<void> {
  const after = await snapshotEngineGeneration(engineDir);
  if (after === before) return;
  throw new GeneralError(
    'engine/ changed while `fireforge test` was running, so this test verdict is invalid/inconclusive.\n\n' +
      'Use one writer per engine checkout, then rebuild and rerun the affected tests.'
  );
}
