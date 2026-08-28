// SPDX-License-Identifier: EUPL-1.2
import { type MachCommandResult, testWithOutput } from './mach.js';
import { tryRepairStaleXpcshellTestSymlink } from './test-stale-symlink.js';

export interface XpcshellRetryClassification {
  xpcshell: readonly string[];
  nonXpcshell: readonly string[];
}

/** Dispatches a (possibly suite-specific) mach test run, mirroring `testWithOutput`. */
export type TestDispatch = (
  engineDir: string,
  testPaths: string[],
  args: string[],
  env?: Record<string, string>,
  fullOutput?: boolean
) => Promise<MachCommandResult>;

/**
 * Removes a stale xpcshell install symlink and retries the focused mach test
 * once. The retry uses the same `dispatch` (suite-specific or generic) the
 * caller is already running on, so an xpcshell-suite run repairs and re-runs
 * via `mach xpcshell-test` rather than falling back to the generic command.
 */
export async function retryAfterXpcshellSymlinkRepair(
  engineDir: string,
  objDir: string | undefined,
  result: MachCommandResult,
  classification: XpcshellRetryClassification,
  normalizedPaths: string[],
  extraArgs: string[],
  env?: Record<string, string>,
  dispatch: TestDispatch = testWithOutput,
  fullOutput?: boolean
): Promise<MachCommandResult> {
  if (
    result.exitCode !== 0 &&
    classification.xpcshell.length > 0 &&
    classification.nonXpcshell.length === 0
  ) {
    const repaired = await tryRepairStaleXpcshellTestSymlink(
      engineDir,
      objDir,
      `${result.stdout}\n${result.stderr}`
    );
    if (repaired) {
      // The repaired re-run is the same logical invocation, so it keeps
      // the verbosity the run was started with.
      if (fullOutput === true) {
        return dispatch(engineDir, normalizedPaths, extraArgs, env, true);
      }
      return env
        ? dispatch(engineDir, normalizedPaths, extraArgs, env)
        : dispatch(engineDir, normalizedPaths, extraArgs);
    }
  }
  return result;
}
