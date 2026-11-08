// SPDX-License-Identifier: EUPL-1.2
import { withEngineSessionLock } from '../core/engine-session-lock.js';
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
