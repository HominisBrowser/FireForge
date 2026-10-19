// SPDX-License-Identifier: EUPL-1.2
/**
 * Pre-dispatch gates for `fireforge test` that stand between the request
 * and a run against a stale or under-packaged runtime: the packaging
 * coverage refusal, the stale-content refusal, and the compiled
 * StaticComponents refusal. Split out of `test.ts` so the command module
 * stays wiring. The probes and refusal copy live in
 * `src/core/test-stale-check.ts`.
 */

import type { BuildBaseline } from '../core/build-baseline-types.js';
import { filterByCarriedFullCoverage } from '../core/coverage-dispatch.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  findChangedTestManifestsForPaths,
  findUncoveredRequestPaths,
  formatStaleBuildWarning,
  formatStaticComponentsRefusal,
  formatTestCoverageRefusal,
  FULL_SUITE_REQUEST,
} from '../core/test-stale-check.js';
import { formatStaleExemptions } from '../core/test-stale-exempt.js';
import { PreflightRefusalError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import { isProcessAlive } from '../utils/errors.js';
import { info, warn } from '../utils/logger.js';
import { describePerfStaleImpact } from './test-perf-scope.js';

/**
 * Stale-build preflight: when `--build` was not requested, detect packageable
 * engine edits since the last successful build and fail up front unless the
 * operator explicitly accepts the stale package risk.
 *
 * Packaging coverage is checked first, on every non-`--build` run and
 * regardless of staleness or `--allow-stale-build`: a runtime packaged by a
 * file-scoped `test --build` can lack support fixtures for other manifests
 * even when nothing changed since, and dispatching such a run hangs on missing
 * fixtures rather than failing, so the flag (which only accepts stale
 * content) must not be the trigger. A three-file scoped rebuild leaving one
 * fixture unpackaged makes a later run over different files time out waiting
 * on an event that never fires.
 *
 * Exception: a path-less `test --doctor` stops at the Marionette health check
 * (`runDoctorPreflight` returns 'stop' when no test paths were given) and
 * never dispatches a test, so it needs no packaging coverage. Treating it as
 * a full-suite request would refuse a probe that touches no fixtures. The
 * stale-content refusal still applies to it unchanged.
 */
export async function enforceStaleBuildGate(
  projectRoot: string,
  engineDir: string,
  options: TestOptions,
  normalizedPaths: readonly string[],
  /** `quiet`: refuse only, without the exemption note (the pre-lock pass). */
  gate: { quiet?: boolean } = {}
): Promise<void> {
  const stale = await checkStaleBuildForTest(projectRoot, engineDir);
  const dispatchesNoTests = options.doctor === true && normalizedPaths.length === 0;
  if (!dispatchesNoTests) {
    await enforceCoverageGate(engineDir, stale.baseline, normalizedPaths);
  }

  await enforceStaticComponentsGate(engineDir, stale.baseline, options);

  const exempt = stale.exempt ?? [];
  if (!stale.stale && exempt.length > 0 && gate.quiet !== true) {
    info(
      `Stale-build preflight: ${exempt.length} edit(s) since the last build need no rebuild: ${formatStaleExemptions(exempt)}.`
    );
  }
  if (!stale.stale) return;

  // The one-line repackaging command, so a build-less sitting (a perf
  // series) can repackage and continue without dispatching anything.
  const repackage =
    normalizedPaths.length > 0
      ? `fireforge test --build-only ${normalizedPaths.join(' ')}`
      : 'fireforge build --ui';
  const perfImpact =
    options.perfSamples === undefined
      ? ''
      : `\n\n${await describePerfStaleImpact(engineDir, stale.changedPaths, normalizedPaths)}`;
  const staleMessage =
    `${formatStaleBuildWarning(stale)}\n\n` +
    'Run `fireforge test --build` to refresh the packaged runtime first — that is almost ' +
    'always the right move, because the usual cause is your own edit landing between the ' +
    'last build and this run. To repackage without running anything: ' +
    `\`${repackage}\`.${perfImpact}\n\n` +
    '`--allow-stale-build` is NOT the general escape hatch: it accepts a packaging that ' +
    'predates the edit under test, so the run tests the OLD code. Pass it only when you ' +
    'rebuilt out-of-band (outside FireForge) and know the packaged runtime already contains ' +
    'the change.';
  if (options.allowStaleBuild === true) {
    warn(staleMessage);
  } else {
    throw new PreflightRefusalError(staleMessage, 'stale-build');
  }
}

/**
 * Packaging-coverage refusal. A path outside the recorded scoped list is
 * still covered while its own staging inputs are unchanged against a
 * carried full-build anchor. The refusal names, per uncovered path, the
 * inputs that changed.
 */
async function enforceCoverageGate(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  normalizedPaths: readonly string[]
): Promise<void> {
  const recordedCoverage = baseline?.testPackagingCoverage;
  const outsideList = findUncoveredRequestPaths(recordedCoverage, normalizedPaths);
  if (outsideList.length === 0) return;
  const remaining = await filterByCarriedFullCoverage(
    engineDir,
    baseline,
    outsideList,
    FULL_SUITE_REQUEST
  );
  if (remaining.length === 0) return;
  const uncovered = remaining.map((request) => request.path);
  // The refusal is correct on its own. Naming the manifest that gained
  // an entry is the triage step it otherwise leaves to the reader.
  const changedManifests = await findChangedTestManifestsForPaths(engineDir, baseline, uncovered);
  throw new PreflightRefusalError(
    formatTestCoverageRefusal(
      uncovered,
      Array.isArray(recordedCoverage) ? recordedCoverage : [],
      changedManifests,
      {
        changedInputs: Object.fromEntries(
          remaining.map((request) => [request.path, request.changed])
        ),
        carriesFullAnchor: baseline?.fullCoverageAnchor !== undefined,
        recordedBy: baseline?.recordedBy,
        builtAt: baseline?.builtAt,
        recorder: baseline?.recorder,
        recorderAlive:
          baseline?.recorder !== undefined &&
          baseline.recorder.pid !== process.pid &&
          isProcessAlive(baseline.recorder.pid),
      }
    ),
    'coverage-replaced'
  );
}

/**
 * Compiled-StaticComponents gate: refuses runs whose child process would
 * resolve a stale compiled component table. `components.conf` entries bake
 * into compiled code that only a full build regenerates. A scoped
 * `test --build` repackages the file but the failure surfaces as
 * `NS_ERROR_MALFORMED_URI` inside the test. Applies to build-less runs
 * (after the coverage refusal) and to scoped `test --build` runs (before
 * the pre-test build, which cannot fix the table). A path-less
 * `test --build` is exempt: its full build refreshes the anchor itself.
 * `--allow-stale-components` downgrades the refusal to a warning.
 */
export async function enforceStaticComponentsGate(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  options: TestOptions
): Promise<void> {
  const result = await checkStaticComponentsStale(engineDir, baseline);
  if (!result.stale) {
    return;
  }
  const message = formatStaticComponentsRefusal(result.changedManifests);
  if (options.allowStaleComponents === true) {
    warn(message);
    return;
  }
  throw new PreflightRefusalError(message, 'stale-components');
}
