// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared collector for "what changed in the engine tree since the last
 * successful build", used by `build-audit`, `build-prepare` and
 * `test-stale-check`.
 */

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

/**
 * Collects engine-relative paths changed since the baseline's HEAD SHA,
 * plus any workdir modifications (tracked and untracked). Defensive — git
 * failures surface as verbose lines and return the files collected so far,
 * so an empty result means "no drift we can prove" rather than "no drift
 * occurred". When the baseline is missing or the engine has no HEAD yet,
 * falls back to workdir-only collection. The result is sorted.
 *
 * @param engineDir - Path to the engine directory
 * @param baseline - Last-build baseline, when one exists
 * @param contextLabel - Prefix for verbose-log lines (e.g. `Audit`,
 *   `Auto-configure`, `Stale-build preflight`) so operators can attribute
 *   the probe that emitted them
 * @returns Sorted engine-relative POSIX paths
 */
export async function collectChangedEnginePaths(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  contextLabel: string
): Promise<string[]> {
  const collected = new Set<string>();

  if (baseline?.engineHeadSha) {
    try {
      const output = await git(
        ['diff', '--name-only', `${baseline.engineHeadSha}..HEAD`],
        engineDir
      );
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
    } catch (error: unknown) {
      if (!isMissingHeadError(error)) {
        verbose(
          `${contextLabel}: could not diff engine against baseline — ${toError(error).message}`
        );
      }
    }
  }

  try {
    if (await hasChanges(engineDir)) {
      const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
      for (const line of worktreeDiff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) collected.add(trimmed);
      }
      for (const untracked of await getUntrackedFiles(engineDir)) {
        collected.add(untracked);
      }
    }
  } catch (error: unknown) {
    verbose(`${contextLabel}: could not enumerate workdir changes — ${toError(error).message}`);
  }

  return [...collected].sort();
}
