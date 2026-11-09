// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { loadConfig } from '../core/config.js';
import { withEngineSessionLock } from '../core/engine-session-lock.js';
import { pathExists } from '../utils/fs.js';
import { resolveWaitLockSeconds } from '../utils/options.js';

/** The slice of a command's parsed options that decides how it locks. */
interface EngineLockOptions {
  dryRun?: boolean | undefined;
  waitLock?: number | boolean | undefined;
}

/**
 * Runs an engine-mutating command's body under the engine-session lock.
 *
 * A `--dry-run` writes nothing, so it takes the lock shared and overlaps other
 * previews; every other run holds it exclusively and cannot rewrite `engine/`
 * under a peer's build, test run or export.
 */
export function runUnderEngineLock<T>(
  projectRoot: string,
  command: string,
  options: EngineLockOptions,
  operation: () => Promise<T>
): Promise<T> {
  const dryRun = options.dryRun === true;
  return withEngineSessionLock(projectRoot, dryRun ? `${command} --dry-run` : command, operation, {
    ...(dryRun ? { mode: 'shared' as const } : {}),
    waitLockSeconds: resolveWaitLockSeconds(options.waitLock),
  });
}

/**
 * Like {@link runUnderEngineLock}, for a command that edits tracked files
 * through the authoring writer. In patch mode those files live in `engine/`,
 * so the edit takes the lock. In source mode the writer targets the tracked
 * source root and never touches `engine/`, so the body runs without it.
 */
export async function runUnderEngineLockForAuthoredEdit<T>(
  projectRoot: string,
  command: string,
  options: EngineLockOptions,
  operation: () => Promise<T>
): Promise<T> {
  const configured = await pathExists(join(projectRoot, 'fireforge.json'));
  if (configured && (await loadConfig(projectRoot)).sources) return operation();
  return runUnderEngineLock(projectRoot, command, options, operation);
}
