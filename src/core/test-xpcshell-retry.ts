// SPDX-License-Identifier: EUPL-1.2
import { type MachCommandResult, type MachTestSuiteKind, runMachTestSuite } from './mach.js';
import { tryRepairStaleXpcshellTestSymlink } from './test-stale-symlink.js';

export interface XpcshellRetryClassification {
  xpcshell: readonly string[];
  nonXpcshell: readonly string[];
}

export interface XpcshellRetryOptions {
  /** Engine checkout the run happened in. */
  engineDir: string;
  /** Object directory the run used, when one is configured. */
  objDir: string | undefined;
  /** Result of the run that may need repairing and retrying. */
  result: MachCommandResult;
  /** Which of the requested paths are xpcshell tests, and which are not. */
  classification: XpcshellRetryClassification;
  /** Test paths, normalized, as handed to mach. */
  normalizedPaths: string[];
  /** Extra mach arguments the run was started with. */
  extraArgs: string[];
  /** Environment overlay for the retried run. */
  env?: Record<string, string> | undefined;
  /** Mach command kind to retry with. Defaults to the generic `test`. */
  kind?: MachTestSuiteKind | undefined;
  /** Whether the run was started with full harness output. */
  fullOutput?: boolean | undefined;
}

/**
 * Removes a stale xpcshell install symlink and retries the focused mach test
 * once. The retry uses the same mach command `kind` (suite-specific or
 * generic) the caller is already running on, so an xpcshell-suite run repairs
 * and re-runs via `mach xpcshell-test` rather than falling back to the
 * generic command.
 */
export async function retryAfterXpcshellSymlinkRepair(
  options: XpcshellRetryOptions
): Promise<MachCommandResult> {
  const {
    engineDir,
    objDir,
    result,
    classification,
    normalizedPaths,
    extraArgs,
    env,
    kind = 'test',
    fullOutput,
  } = options;
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
      return runMachTestSuite(kind, {
        engineDir,
        testPaths: normalizedPaths,
        args: extraArgs,
        env,
        fullOutput,
      });
    }
  }
  return result;
}
