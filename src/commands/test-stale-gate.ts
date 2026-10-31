// SPDX-License-Identifier: EUPL-1.2
/**
 * Pre-dispatch gates for `fireforge test` that stand between the request
 * and a run against a stale or under-packaged runtime: the packaging
 * coverage refusal, the stale-content refusal, and the compiled
 * StaticComponents refusal. Split out of `test.ts` so the command module
 * stays wiring. The probes and refusal copy live in
 * `src/core/test-stale-check.ts`.
 */

import type { BuildBaseline, ControlBuildStamp } from '../core/build-baseline-types.js';
import { filterByCarriedFullCoverage } from '../core/coverage-dispatch.js';
import { normalizeRequestPath } from '../core/coverage-records.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  findChangedTestManifestsForPaths,
  findCompiledSourcesNewerThanBinary,
  findUncoveredRequestPaths,
  formatStaleBuildWarning,
  formatStaleCompiledRefusal,
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
import { formatVerdictPathList, setVerdictRunAttribute } from './test-verdict.js';

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
  /**
   * `quiet`: refuse only, without the exemption note (the pre-lock pass).
   * `launchablePath`: the engine-relative binary the run launches, which
   * anchors the stale-compiled check (skipped without one).
   * `ownControlBuild`: the stamp this invocation's own compiled-control
   * build recorded, on the runs after the first (see
   * {@link enforceControlBuiltGate}).
   */
  gate: {
    quiet?: boolean;
    launchablePath?: string | undefined;
    ownControlBuild?: ControlBuildStamp | undefined;
  } = {}
): Promise<void> {
  const stale = await checkStaleBuildForTest(projectRoot, engineDir);
  const ownControl = isOwnControlBuild(stale.baseline, gate.ownControlBuild);
  if (!ownControl) enforceControlBuiltGate(stale.baseline);
  const dispatchesNoTests = options.doctor === true && normalizedPaths.length === 0;
  if (!dispatchesNoTests) {
    await enforceCoverageGate(engineDir, stale.baseline, normalizedPaths);
  }

  await enforceStaticComponentsGate(engineDir, stale.baseline, options);
  await enforceStaleCompiledGate(
    engineDir,
    stale.baseline,
    options,
    gate.launchablePath,
    new Set(ownControl ? stale.baseline?.controlBuild?.targets : [])
  );

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
 * Whether the recorded control-built stamp is the one this invocation's own
 * control build wrote (same diff file, same application time, as
 * `controlBuildRecorded` compares). A `--repeat` or mixed-harness run after
 * the first tests that binary on purpose, with the control applied again.
 */
function isOwnControlBuild(
  baseline: BuildBaseline | undefined,
  own: ControlBuildStamp | undefined
): boolean {
  const stamp = baseline?.controlBuild;
  return (
    stamp !== undefined &&
    own !== undefined &&
    stamp.diffFile === own.diffFile &&
    stamp.appliedAt === own.appliedAt
  );
}

/**
 * Control-built refusal: the recorded build compiled a negative control
 * into the binary, and no build since has recompiled the restored source
 * (the run was killed, or its restore build failed). Every test against
 * that binary tests the mutation. Not bypassable: `--allow-stale-build`
 * accepts old content, not a deliberately broken binary. The runs after the
 * first of the invocation that built the control skip it (see
 * {@link isOwnControlBuild}).
 */
function enforceControlBuiltGate(baseline: BuildBaseline | undefined): void {
  const stamp = baseline?.controlBuild;
  if (stamp === undefined) return;
  throw new PreflightRefusalError(
    `The binary under test was built with the negative control ${stamp.diffFile} applied ` +
      `(${stamp.targets.map((target) => `engine/${target}`).join(', ')}, applied ${stamp.appliedAt}), ` +
      'and no build has recompiled the restored source since. Run "fireforge build" to ' +
      'rebuild the binary without the control, then rerun.',
    'control-built'
  );
}

/**
 * Stale-compiled refusal: compiled sources modified after the binary under
 * test was linked. `--allow-stale-build` downgrades it to a warning, as it
 * does the stale-build refusal. `ownControlTargets` are skipped: an
 * invocation's own compiled control restores them with a fresh mtime after
 * each run, while the binary still carries the control the next run applies
 * again.
 */
async function enforceStaleCompiledGate(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  options: TestOptions,
  launchablePath: string | undefined,
  ownControlTargets: ReadonlySet<string>
): Promise<void> {
  const found = await findCompiledSourcesNewerThanBinary(engineDir, baseline, launchablePath);
  if (found === undefined) return;
  const result = { ...found, paths: found.paths.filter((path) => !ownControlTargets.has(path)) };
  if (result.paths.length === 0) return;
  const message = formatStaleCompiledRefusal(result);
  if (options.allowStaleBuild === true) {
    warn(message);
    return;
  }
  throw new PreflightRefusalError(message, 'stale-compiled');
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
  stampBuildPaths(uncovered);
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
 * Names the paths a `coverage-replaced` refusal tells the operator to
 * rebuild as `build-paths=` on the verdict line, uncapped and normalized,
 * so a script can retry with `--build <paths>` without parsing the prose.
 * A whole-suite request has no scoped retry and stamps nothing.
 */
function stampBuildPaths(uncovered: readonly string[]): void {
  const paths = uncovered
    .filter((path) => path !== FULL_SUITE_REQUEST)
    .map((path) => normalizeRequestPath(path));
  if (paths.length === 0 || paths.includes('')) return;
  setVerdictRunAttribute('build-paths', formatVerdictPathList([...new Set(paths)]));
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
