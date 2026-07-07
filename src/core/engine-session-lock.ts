// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { withFileLock } from './file-lock.js';
import { git } from './git-base.js';

const ENGINE_SESSION_LOCK_PATH = join('.fireforge', 'engine-session.lock');

/**
 *
 */
export async function withEngineSessionLock<T>(
  projectRoot: string,
  command: string,
  operation: () => Promise<T>
): Promise<T> {
  if (
    process.env['FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST'] !== '1' &&
    (process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined)
  ) {
    return operation();
  }
  return withFileLock(join(projectRoot, ENGINE_SESSION_LOCK_PATH), operation, {
    timeoutMs: 1000,
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
