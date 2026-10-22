// SPDX-License-Identifier: EUPL-1.2
/**
 * The restore build after a compiled negative control.
 *
 * A control on compiled source is applied before a full pre-test build, so
 * the binary under test carries it. Restoring the source byte-exact after
 * the run does not unbuild it: the objdir binary keeps the mutation until a
 * build recompiles the original. Every later `fireforge test` would then
 * test the control. The orchestrator therefore runs one more full
 * `mach build` right after a successful restore, still under the same
 * engine-session hold, and its baseline drops the `controlBuild` stamp the
 * control's build recorded. When that build fails, or the run never gets
 * here (killed), the stamp stays and the next `fireforge test` refuses with
 * `note=control-built` until `fireforge build` replaces it.
 */

import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import type { ControlBuildStamp } from '../core/build-baseline-types.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { runProtectedMachBuild, withBuildLock } from '../core/mach.js';
import { toError } from '../utils/errors.js';
import { info, notice, verbose, warn } from '../utils/logger.js';

/** Outcome of {@link runControlRestoreBuild}, stamped as `control-restore-build=`. */
export type ControlRestoreBuildOutcome = 'done' | 'failed';

/**
 * Whether the recorded baseline is the one this run's control build wrote:
 * only then did a build compile the control in (a failed control build
 * writes no baseline, and its restored source's fresh mtime trips the
 * stale-compiled check instead).
 *
 * @param projectRoot - Project root
 * @param stamp - The stamp this run's control build recorded
 */
export async function controlBuildRecorded(
  projectRoot: string,
  stamp: ControlBuildStamp
): Promise<boolean> {
  const baseline = await readBuildBaseline(projectRoot);
  return (
    baseline?.controlBuild?.appliedAt === stamp.appliedAt &&
    baseline.controlBuild.diffFile === stamp.diffFile
  );
}

/**
 * Rebuilds the binary after a compiled control was restored: a full
 * protected `mach build` under the build lock, then a baseline without the
 * stamp. The previous baseline's packaging-coverage claim is carried
 * forward unchanged, since recompiling the restored source stages no tests.
 * Never throws: a failure leaves the stamp in place, which is the refusal
 * the next run needs.
 *
 * @param projectRoot - Project root
 * @param stamp - The stamp this run's control build recorded
 * @param harnessRetries - Recognized-crash retry budget for the build
 */
export async function runControlRestoreBuild(
  projectRoot: string,
  stamp: ControlBuildStamp,
  harnessRetries: number | undefined
): Promise<ControlRestoreBuildOutcome> {
  const paths = getProjectPaths(projectRoot);
  notice(
    `Rebuilding after the compiled negative control (${stamp.targets.map((target) => `engine/${target}`).join(', ')}): ` +
      'the binary still carries the mutation until a full mach build recompiles the restored source.'
  );
  try {
    const config = await loadConfig(projectRoot);
    return await withBuildLock(projectRoot, async () => {
      const previousBaseline = await readBuildBaseline(projectRoot);
      const result = await runProtectedMachBuild('full', paths.engine, {
        ...(harnessRetries === undefined ? {} : { retries: harnessRetries }),
      });
      if (result.exitCode !== 0) {
        warn(
          'The restore build after the negative control failed, so the binary still carries ' +
            'the control. The next "fireforge test" refuses (note=control-built) until ' +
            '"fireforge build" succeeds.'
        );
        return 'failed';
      }
      await writeBuildBaseline({
        projectRoot,
        engineDir: paths.engine,
        binaryName: config.binaryName,
        testPackagingCoverage: previousBaseline?.testPackagingCoverage,
        testCoverageRecords: previousBaseline?.testCoverageRecords,
        fullCoverageAnchor: previousBaseline?.fullCoverageAnchor,
        previousBaseline,
        recordedBy: 'fireforge test --negative-control (restore build)',
        staticComponentsHandling: 'refresh',
        buildKind: 'full',
      });
      info('Restore build complete: the binary no longer carries the negative control.');
      return 'done';
    });
  } catch (error: unknown) {
    verbose(`Restore build after the negative control failed: ${toError(error).message}`);
    warn(
      `The restore build after the negative control could not run (${toError(error).message}). ` +
        'The next "fireforge test" refuses (note=control-built) until "fireforge build" succeeds.'
    );
    return 'failed';
  }
}
