// SPDX-License-Identifier: EUPL-1.2
import { notice } from '../utils/logger.js';
import { readBuildBaseline } from './build-baseline.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { isCommitMissing } from './engine-changes.js';

/**
 * The last-build record, or undefined when there is none or the commit it
 * anchors to is not in this repository. The second case gets a notice, since
 * the record exists on disk and the build about to run replaces it.
 *
 * @param projectRoot - Project root
 * @param engineDir - Absolute engine directory
 */
export async function readUsableBuildBaseline(
  projectRoot: string,
  engineDir: string
): Promise<{ baseline: BuildBaseline | undefined; anchorMissing: boolean }> {
  const baseline = await readBuildBaseline(projectRoot);
  if (!baseline?.engineHeadSha) return { baseline, anchorMissing: false };
  if (!(await isCommitMissing(engineDir, baseline.engineHeadSha)))
    return { baseline, anchorMissing: false };
  notice(
    `The last recorded build anchors to engine commit ${baseline.engineHeadSha}, which no longer ` +
      'exists in engine/; treating the build as unrecorded. A UI build runs as a full one, and this build records a new baseline.'
  );
  return { baseline: undefined, anchorMissing: true };
}
