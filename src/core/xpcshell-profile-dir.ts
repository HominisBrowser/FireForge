// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-invocation xpcshell profile directory.
 *
 * Firefox's xpcshell harness defaults `XPCSHELL_TEST_PROFILE_DIR` to a
 * FIXED path (`$TMPDIR/firefox/xpcshellprofile`), so two overlapping
 * harness invocations — concurrent `fireforge test` processes, or future
 * verification-tree shards — corrupt each other's profiles. FireForge
 * never set the variable; this helper mints a fresh `mkdtemp` directory
 * per harness invocation and exports it through the mach env channel.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { warn } from '../utils/logger.js';

export const XPCSHELL_PROFILE_ENV_VAR = 'XPCSHELL_TEST_PROFILE_DIR';

/**
 * Runs `fn` with a fresh per-invocation xpcshell profile directory
 * injected into the environment, removing the directory afterwards
 * (best-effort — a failure to clean up warns and leaves the mkdtemp dir
 * for the OS tmp reaper; the harness may still hold files briefly).
 *
 * An operator-provided `XPCSHELL_TEST_PROFILE_DIR` (in `baseEnv` or the
 * process environment) is respected verbatim: no directory is minted and
 * NOTHING is deleted — we never remove a directory we did not create.
 */
export async function withXpcshellProfileDir<T>(
  baseEnv: Record<string, string> | undefined,
  fn: (env: Record<string, string>) => Promise<T>
): Promise<T> {
  const operatorProvided =
    baseEnv?.[XPCSHELL_PROFILE_ENV_VAR] ?? process.env[XPCSHELL_PROFILE_ENV_VAR];
  if (operatorProvided !== undefined && operatorProvided !== '') {
    return fn({ ...baseEnv, [XPCSHELL_PROFILE_ENV_VAR]: operatorProvided });
  }

  const profileDir = await mkdtemp(join(tmpdir(), 'fireforge-xpcshell-profile-'));
  try {
    return await fn({ ...baseEnv, [XPCSHELL_PROFILE_ENV_VAR]: profileDir });
  } finally {
    try {
      await rm(profileDir, { recursive: true, force: true });
    } catch (error: unknown) {
      warn(`Could not clean up xpcshell profile dir ${profileDir}: ${toError(error).message}`);
    }
  }
}
