// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared collector for "what changed in the engine tree since the last
 * successful build", used by `build-audit`, `build-prepare` and
 * `test-stale-check`.
 */

import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { hashEngineFile } from './coverage-extend.js';
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

/**
 * Drops every path whose live content still matches the fingerprint the
 * last successful build recorded for it, keeping the rest. Shared by the
 * stale-build preflight (`packageableFingerprints`) and the auto-configure /
 * full-build escalation in `build-prepare` (`buildInputFingerprints`).
 *
 * A path with no recorded entry, an unreadable file, or a differing hash
 * is kept — "cannot prove unchanged" must never turn into "unchanged".
 * With no fingerprint set at all (a baseline written before the field
 * existed) every path is kept, which is the path-only comparison the
 * fingerprints refine.
 *
 * @param engineDir - Path to the engine directory
 * @param paths - Candidate engine-relative POSIX paths
 * @param fingerprints - Recorded hashes keyed by engine-relative path
 * @returns The subset of `paths` that cannot be proven unchanged
 */
export async function dropPathsMatchingFingerprints(
  engineDir: string,
  paths: readonly string[],
  fingerprints: Record<string, string> | undefined
): Promise<string[]> {
  if (!fingerprints) return [...paths];
  const kept: string[] = [];
  for (const path of paths) {
    const recorded = fingerprints[path];
    if (recorded === undefined) {
      kept.push(path);
      continue;
    }
    const live = await hashEngineFile(engineDir, path);
    if (live === undefined || live !== recorded) kept.push(path);
  }
  return kept;
}
