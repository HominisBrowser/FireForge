// SPDX-License-Identifier: EUPL-1.2
/**
 * What the last recorded build says about the binary a command is about to ship
 * or launch. `fireforge test` has its own gates with its own remedies; this is
 * the same evidence for the commands that take the objdir as it stands.
 */

import { readBuildBaseline } from './build-baseline.js';
import { withEngineStateHold } from './engine-state.js';
import {
  checkStaleBuildForTest,
  findCompiledSourcesNewerThanBinary,
  formatControlBuiltRefusal,
  formatStaleBuildWarning,
  formatStaleCompiledRefusal,
} from './test-stale-check.js';

/** What is wrong with the build under consideration; empty when nothing is. */
export interface BuildProvenanceFindings {
  /** The binary still carries a negative control. No flag accepts this. */
  controlBuilt?: string;
  /** No build is recorded, so nothing can vouch for the objdir. */
  noBaseline?: string;
  /** The tree moved past the recorded build. */
  stale?: string[];
}

/**
 * Judges the objdir against the recorded build.
 *
 * @param projectRoot - Project root
 * @param engineDir - Absolute engine directory
 * @param launchablePath - Engine-relative launchable binary path
 */
export async function assessBuildProvenance(
  projectRoot: string,
  engineDir: string,
  launchablePath: string | undefined
): Promise<BuildProvenanceFindings> {
  const baseline = await readBuildBaseline(projectRoot);
  if (baseline === undefined) {
    return { noBaseline: 'No successful fireforge build is recorded for this objdir.' };
  }
  const stamp = baseline.controlBuild;
  if (stamp !== undefined) return { controlBuilt: formatControlBuiltRefusal(stamp) };
  return withEngineStateHold(async () => {
    const stale: string[] = [];
    const content = await checkStaleBuildForTest(projectRoot, engineDir);
    if (content.unusableBaseline !== undefined) return { noBaseline: content.unusableBaseline };
    if (content.stale) stale.push(formatStaleBuildWarning(content));
    const compiled = await findCompiledSourcesNewerThanBinary(engineDir, baseline, launchablePath);
    if (compiled !== undefined && compiled.paths.length > 0) {
      stale.push(formatStaleCompiledRefusal(compiled));
    }
    return stale.length > 0 ? { stale } : {};
  });
}
