// SPDX-License-Identifier: EUPL-1.2
import { hermeticGitEnvironment } from './git-hermetic.js';
import { readAdmittedSnapshot } from './jobs/guard.js';

const phases = new Map<
  string,
  Promise<{ executable: string; environment: Record<string, string> }>
>();
/** One process stays inside one owned phase; Git paths are live-capability authenticated before reuse. */
export async function qualifiedGitRuntime(): Promise<
  { executable: string; environment: Record<string, string> } | undefined
> {
  const token = process.env['FIREFORGE_JOB_TOKEN'];
  if (token === undefined) return undefined;
  const key = JSON.stringify([
    token,
    process.env['FIREFORGE_JOB_PHASE'],
    process.env['FIREFORGE_EXECUTION_ROOT'],
  ]);
  let pending = phases.get(key);
  if (!pending) {
    pending = (async () => {
      const admitted = await readAdmittedSnapshot(
        process.env['FIREFORGE_EXECUTION_ROOT'] ?? process.cwd()
      );
      if (!admitted.gitExecutable || !admitted.gitExecPath)
        throw new Error('Admitted phase lacks a qualified Git runtime');
      return {
        executable: admitted.gitExecutable,
        environment: hermeticGitEnvironment(admitted.gitExecPath),
      };
    })();
    phases.set(key, pending);
  }
  return pending;
}
