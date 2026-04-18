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

import { join } from 'node:path';

import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { getHead, isMissingHeadError } from './git.js';

/** Shape of the on-disk baseline marker. */
export interface BuildBaseline {
  /** SHA of engine HEAD at the time the build succeeded. */
  engineHeadSha: string;
  /**
   * ISO-8601 timestamp of when the baseline was recorded. Informational —
   * downstream code keys off `engineHeadSha` for diffs, but the timestamp
   * helps operators reason about stale markers.
   */
  builtAt: string;
  /**
   * The binaryName used at build time. Captured so the dist-tree audit
   * can resolve the expected bundle root under obj-star/dist/ even when
   * the project has since been renamed.
   */
  binaryName: string;
}

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
 */
export async function writeBuildBaseline(
  projectRoot: string,
  engineDir: string,
  binaryName: string
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

  const baseline: BuildBaseline = {
    engineHeadSha,
    builtAt: new Date().toISOString(),
    binaryName,
  };
  await writeJson(getBuildBaselinePath(projectRoot), baseline);
}
