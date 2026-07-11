// SPDX-License-Identifier: EUPL-1.2
/**
 * Persists a marker describing the state of the engine tree at the time of
 * the last successful `fireforge build`. Two downstream consumers share this
 * marker:
 *
 *   - `build-audit`: after a build succeeds, compare engine files touched
 *     since the baseline against the dist bundle to flag silent
 *     packaging drops (e.g. a pref file never registered in moz.build).
 *   - `build-prepare`: before a build starts, detect whether any
 *     `moz.build` / `moz.configure` / `Makefile.in` changed since the
 *     baseline and run `mach configure` before the build step so the
 *     recursive-make backend isn't stale.
 *
 * The marker lives under `.fireforge/last-build.json`. It is written only
 * on successful build completion; a failed build does not update it, so a
 * subsequent run still audits against the last known-good tree.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isPackageablePath } from './build-audit.js';
import type { BuildBaseline, TestPackagingCoverage } from './build-baseline-types.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { getHead, hasChanges, isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

/** Name of the last-build marker file under `.fireforge/`. */
export const BUILD_BASELINE_FILENAME = 'last-build.json';

/**
 * Resolves the on-disk path of the build baseline marker.
 * @param projectRoot - Root directory of the project
 * @returns Absolute path of the marker file
 */
export function getBuildBaselinePath(projectRoot: string): string {
  return join(projectRoot, FIREFORGE_DIR, BUILD_BASELINE_FILENAME);
}

/**
 * Reads the last-build baseline if present. Returns undefined when no
 * previous successful build has been recorded — callers must tolerate that
 * path (first build, cleaned workspace).
 * @param projectRoot - Root directory of the project
 */
export async function readBuildBaseline(projectRoot: string): Promise<BuildBaseline | undefined> {
  const path = getBuildBaselinePath(projectRoot);
  if (!(await pathExists(path))) {
    return undefined;
  }
  try {
    return await readJson<BuildBaseline>(path);
  } catch {
    // A corrupt marker is equivalent to no marker — the audit/auto-configure
    // will treat it as "first build" rather than block on the inconsistency.
    return undefined;
  }
}

/**
 * Records a successful build by writing a fresh baseline marker. Captures
 * engine HEAD SHA (or an empty string when the engine has no HEAD yet) and
 * the current binaryName. Caller is responsible for only invoking this
 * after the build exit code was zero.
 * @param projectRoot - Root directory of the project
 * @param engineDir - Path to the engine directory
 * @param binaryName - Current `binaryName` from fireforge.json
 * @param testPackagingCoverage - Coverage claim of the packaged test
 *   runtime this build produced (`'full'`, or the scoped request paths of
 *   a `test --build` invocation). Omitted → field left off the marker.
 */
export async function writeBuildBaseline(
  projectRoot: string,
  engineDir: string,
  binaryName: string,
  testPackagingCoverage?: TestPackagingCoverage
): Promise<void> {
  let engineHeadSha = '';
  try {
    engineHeadSha = await getHead(engineDir);
  } catch (error: unknown) {
    // Engine may be an unborn branch (freshly cloned + reset, or mid-import)
    // — record an empty SHA and let downstream fall back to "no prior state"
    // behavior. Any other git failure is bubbled up; we don't want to
    // silently write a garbage marker.
    if (!isMissingHeadError(error)) {
      throw error;
    }
  }

  const packageableFingerprints = await collectPackageableFingerprints(engineDir);

  const baseline: BuildBaseline = {
    engineHeadSha,
    builtAt: new Date().toISOString(),
    binaryName,
    ...(packageableFingerprints !== undefined ? { packageableFingerprints } : {}),
    ...(testPackagingCoverage !== undefined ? { testPackagingCoverage } : {}),
  };
  await writeJson(getBuildBaselinePath(projectRoot), baseline);
}

/**
 * Reads the current engine workdir and computes a SHA-256 fingerprint
 * for every packageable path that is either modified against HEAD or
 * untracked. The stale-build preflight (`checkStaleBuildForTest`)
 * compares the live fingerprint for each packageable-dirty file to
 * the baseline's entry — paths where the hash matches are "the build
 * already saw this exact content", paths where it differs (or that
 * are new since the baseline) are genuinely stale.
 *
 * Returns `undefined` on any git failure so a broken probe never
 * corrupts the on-disk baseline with `{}`; the stale-check then falls
 * back to the pre-0.16.0 "path-only" behavior on the next test run.
 */
async function collectPackageableFingerprints(
  engineDir: string
): Promise<Record<string, string> | undefined> {
  try {
    const dirtyPaths = new Set<string>();
    if (await hasChanges(engineDir)) {
      const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
      for (const line of worktreeDiff.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) dirtyPaths.add(trimmed);
      }
      for (const untracked of await getUntrackedFiles(engineDir)) {
        dirtyPaths.add(untracked);
      }
    }

    const packageable = [...dirtyPaths].filter(isPackageablePath);
    if (packageable.length === 0) {
      return {};
    }

    const fingerprints: Record<string, string> = {};
    for (const relPath of packageable) {
      try {
        const buffer = await readFile(join(engineDir, relPath));
        fingerprints[relPath] = createHash('sha256').update(buffer).digest('hex');
      } catch (fileError: unknown) {
        // A file that disappeared between status probe and hash is
        // expected in concurrent scenarios; skip it without failing the
        // whole baseline write.
        verbose(
          `Build baseline: skipping fingerprint for ${relPath} — ${toError(fileError).message}`
        );
      }
    }
    return fingerprints;
  } catch (error: unknown) {
    verbose(`Build baseline: packageable fingerprint probe failed — ${toError(error).message}`);
    return undefined;
  }
}
