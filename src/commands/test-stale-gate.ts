// SPDX-License-Identifier: EUPL-1.2
/**
 * Pre-dispatch gates for `fireforge test` that stand between the request
 * and a run against a stale or under-packaged runtime: the packaging
 * coverage refusal, the stale-content refusal, and the compiled
 * StaticComponents refusal. Split out of `test.ts` so the command module
 * stays wiring; the probes and refusal copy live in
 * `src/core/test-stale-check.ts`.
 */

import type { BuildBaseline } from '../core/build-baseline-types.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  findChangedTestManifestsForPaths,
  findUncoveredRequestPaths,
  formatStaleBuildWarning,
  formatStaticComponentsRefusal,
  formatTestCoverageRefusal,
} from '../core/test-stale-check.js';
import { GeneralError } from '../errors/base.js';
import type { TestOptions } from '../types/commands/index.js';
import { warn } from '../utils/logger.js';

/**
 * Stale-build preflight — when `--build` was NOT requested, detect packageable
 * engine edits since the last successful build and fail UP-FRONT unless the
 * operator explicitly accepts the stale package risk.
 *
 * Packaging COVERAGE is checked first, on EVERY non-`--build` run and
 * regardless of staleness or `--allow-stale-build`: a runtime packaged by a
 * file-scoped `test --build` can lack support fixtures for OTHER manifests
 * even when nothing changed since — dispatching such a run hangs on missing
 * fixtures rather than failing, so the flag (which only accepts stale
 * CONTENT) must not be the trigger. A three-file scoped rebuild leaving one
 * fixture unpackaged makes a later run over different files time out waiting
 * on an event that never fires.
 *
 * Exception: a path-less `test --doctor` stops at the Marionette health check
 * (`runDoctorPreflight` returns 'stop' when no test paths were given) and
 * never dispatches a test, so it needs no packaging coverage — treating it as
 * a full-suite request would refuse a probe that touches no fixtures. The
 * stale-content refusal still applies to it unchanged.
 */
export async function enforceStaleBuildGate(
  projectRoot: string,
  engineDir: string,
  options: TestOptions,
  normalizedPaths: readonly string[]
): Promise<void> {
  const stale = await checkStaleBuildForTest(projectRoot, engineDir);
  const dispatchesNoTests = options.doctor === true && normalizedPaths.length === 0;
  if (!dispatchesNoTests) {
    const recordedCoverage = stale.baseline?.testPackagingCoverage;
    const uncovered = findUncoveredRequestPaths(recordedCoverage, normalizedPaths);
    if (uncovered.length > 0) {
      // The refusal is correct on its own; naming the manifest that gained
      // an entry is the triage step it otherwise leaves to the reader.
      const changedManifests = await findChangedTestManifestsForPaths(
        engineDir,
        stale.baseline,
        uncovered
      );
      throw new GeneralError(
        formatTestCoverageRefusal(
          uncovered,
          Array.isArray(recordedCoverage) ? recordedCoverage : [],
          changedManifests
        )
      );
    }
  }

  await enforceStaticComponentsGate(engineDir, stale.baseline, options);

  const staleMessage = stale.stale
    ? `${formatStaleBuildWarning(stale)}\n\n` +
      'Run `fireforge test --build` to refresh the packaged runtime first — that is almost ' +
      'always the right move, because the usual cause is your own edit landing between the ' +
      'last build and this run.\n\n' +
      '`--allow-stale-build` is NOT the general escape hatch: it accepts a packaging that ' +
      'predates the edit under test, so the run tests the OLD code. Pass it only when you ' +
      'rebuilt out-of-band (outside FireForge) and know the packaged runtime already contains ' +
      'the change.'
    : undefined;
  if (staleMessage !== undefined) {
    if (options.allowStaleBuild === true) {
      warn(staleMessage);
    } else {
      throw new GeneralError(staleMessage);
    }
  }
}

/**
 * Compiled-StaticComponents gate — refuses runs whose child process would
 * resolve a stale compiled component table. `components.conf` entries bake
 * into compiled code that only a FULL build regenerates; a scoped
 * `test --build` repackages the file but the failure surfaces as
 * `NS_ERROR_MALFORMED_URI` inside the test. Applies to build-less runs
 * (after the coverage refusal) AND to scoped `test --build` runs (before
 * the pre-test build — that build cannot fix the table). A path-less
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
  throw new GeneralError(message);
}
