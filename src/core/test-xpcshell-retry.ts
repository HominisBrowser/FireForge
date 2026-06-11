// SPDX-License-Identifier: EUPL-1.2
import { type MachCommandResult, testWithOutput } from './mach.js';
import { tryRepairStaleXpcshellTestSymlink } from './test-stale-symlink.js';

export interface XpcshellRetryClassification {
  xpcshell: readonly string[];
  nonXpcshell: readonly string[];
}

/** Removes a stale xpcshell install symlink and retries the focused mach test once. */
export async function retryAfterXpcshellSymlinkRepair(
  engineDir: string,
  objDir: string | undefined,
  result: MachCommandResult,
  classification: XpcshellRetryClassification,
  normalizedPaths: string[],
  extraArgs: string[],
  env?: Record<string, string>
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
      return env
        ? testWithOutput(engineDir, normalizedPaths, extraArgs, env)
        : testWithOutput(engineDir, normalizedPaths, extraArgs);
    }
  }
  return result;
}
