// SPDX-License-Identifier: EUPL-1.2
/**
 * Pre-test build phase for `fireforge test`, split out of `test.ts` (at
 * the per-file line budget): the incremental protected mach build with
 * its baseline write, and the `--build-only` union-build shape.
 */

import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import type { TestPackagingCoverage } from '../core/build-baseline-types.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import type { getProjectPaths, loadConfig } from '../core/config.js';
import {
  checkExtendCoverageAnchor,
  checkExtendMozconfigAnchor,
  formatExtendCoverageRefusal,
  unionTestPackagingCoverage,
} from '../core/coverage-extend.js';
import { runProtectedMachBuild, withBuildLock } from '../core/mach.js';
import { buildHarnessCrashMessage } from '../core/test-harness-crash.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { info, notice, spinner, verbose } from '../utils/logger.js';
import type { HarnessClassification } from './test-modes.js';
import { reportBuildOnlyCompletion } from './test-modes.js';
import { enforceStaleBuildGate, enforceStaticComponentsGate } from './test-stale-gate.js';
import { emitPassVerdict } from './test-verdict.js';

async function runPreTestBuild(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  projectConfig: Awaited<ReturnType<typeof loadConfig>>,
  harnessRetries: number,
  testPackagingCoverage: TestPackagingCoverage,
  refuseUnexportedDrift: boolean,
  extend?: { requestedPaths: string[] }
): Promise<void> {
  await withBuildLock(projectRoot, async () => {
    // Pass the previous baseline exactly like `fireforge build` does, so
    // auto-configure runs under the same conditions on both paths. The
    // pre-test build must never invalidate more of the objdir than a plain
    // `mach build faster` would — a failed pre-test build followed by a full
    // rebuild is an hour where an incremental one would have sufficed.
    const previousBaseline = await readBuildBaseline(projectRoot);
    const preparation = await prepareBuildEnvironment(projectRoot, paths, projectConfig, {
      previousBaseline,
      refuseUnexportedDrift,
    });

    // The mozconfig half of the --extend-coverage anchor can
    // only be checked once prepareBuildEnvironment has regenerated
    // engine/mozconfig — that is the file this build will configure with —
    // and must still be checked before mach, so a refusal costs no build.
    if (extend !== undefined) {
      const mozconfigAnchor = await checkExtendMozconfigAnchor(paths.engine, previousBaseline);
      if (!mozconfigAnchor.ok) {
        throw new GeneralError(formatExtendCoverageRefusal(mozconfigAnchor));
      }
    }

    const buildKind = preparation.fullBuildRequired ? 'full' : 'faster';
    if (preparation.fullBuildRequired) {
      // Warning severity, not info: agent-facing output filters
      // keep warnings and errors only, and this is the line that explains an
      // otherwise unexplained multi-minute build.
      notice(
        'A jar.mn registration changed since the last successful build; escalating this pre-test build to a full mach build so new install-manifest destinations are created.'
      );
    }
    const s = spinner(
      preparation.fullBuildRequired
        ? 'Running required full build...'
        : 'Running incremental build...'
    );
    // The pre-test build routes through the same protected mach dispatch as
    // `fireforge build` / `build --ui`: in-venv resource-monitor guard plus
    // the uniform recognized-crash retry budget, with a fresh mach process
    // (and fresh guard install) per attempt. prepareBuildEnvironment runs
    // ONCE, outside the retry loop — retries never re-run mach configure.
    const result = await runProtectedMachBuild(buildKind, paths.engine, {
      retries: harnessRetries,
      onRetry: (signature, nextAttempt, maxAttempts) => {
        s.message(
          `Pre-test build hit a harness crash (${signature.reason}); ` +
            `retrying (attempt ${nextAttempt} of ${maxAttempts})...`
        );
      },
    });
    if (result.exitCode === 0) {
      s.stop('Build complete');
      // Same record, same failure tolerance as `fireforge build` /
      // `build --ui` (build.ts): a green pre-test build refreshes the
      // stale-build baseline so a later plain `fireforge test` over the same
      // files is not refused. A failed write never fails the run. The
      // coverage claim is scoped to the requested test paths, since a
      // file-scoped `test --build` only guarantees packaging for those
      // manifests. The previous baseline is passed through so a scoped write
      // carries the static-components anchor forward — `mach build faster`
      // does not rebake components.conf into the compiled table.
      try {
        // Under --extend-coverage the claim is the UNION of the previous
        // record and this build's paths, and the static-components anchor
        // is always carried forward: that union can evaluate to 'full'
        // while the build behind it was a scoped `mach build faster` that
        // did not rebake the compiled table.
        const recordedCoverage =
          extend !== undefined
            ? unionTestPackagingCoverage(
                previousBaseline?.testPackagingCoverage,
                extend.requestedPaths
              )
            : testPackagingCoverage;
        await writeBuildBaseline(
          projectRoot,
          paths.engine,
          projectConfig.binaryName,
          recordedCoverage,
          previousBaseline,
          describeBuildInvocation(extend !== undefined, testPackagingCoverage),
          preparation.fullBuildRequired
            ? 'refresh'
            : extend !== undefined
              ? 'carry-forward'
              : 'auto'
        );
      } catch (baselineError: unknown) {
        verbose(`Could not persist build baseline: ${toError(baselineError).message}`);
      }
      return;
    }
    s.error('Pre-test build failed');
    throw new BuildError(
      result.crashSignature
        ? buildHarnessCrashMessage(result.crashSignature, result.attempts, 'mach build faster')
        : 'Pre-test build failed',
      preparation.fullBuildRequired ? 'mach build' : 'mach build faster'
    );
  });
}

/**
 * `--extend-coverage` only means something for a SCOPED build: it unions
 * this build's paths onto the recorded claim. Without `--build`/
 * `--build-only` there is no build to extend from, and a path-less build
 * records `'full'`, which already covers everything — refusing both is more
 * honest than silently ignoring the flag.
 */
function assertExtendCoverageUsage(options: TestOptions, normalizedPaths: string[]): void {
  if (options.build !== true && options.buildOnly !== true) {
    throw new InvalidArgumentError(
      '--extend-coverage requires --build or --build-only: it unions the paths a build packages onto the recorded coverage claim.',
      '--extend-coverage'
    );
  }
  if (normalizedPaths.length === 0) {
    throw new InvalidArgumentError(
      '--extend-coverage requires explicit test paths: a path-less build records full coverage, which already covers every path.',
      '--extend-coverage'
    );
  }
}

/**
 * Refuses `--refuse-unexported-drift` on a run that dispatches no build.
 * The flag governs the PRE-TEST build only, so accepting it without
 * `--build`/`--build-only` would arm a belt over work that never happens —
 * exactly the silent no-op this release fixes elsewhere.
 */
function assertRefuseUnexportedDriftUsage(options: TestOptions): void {
  if (options.refuseUnexportedDrift !== true) return;
  if (options.build === true || options.buildOnly === true) return;
  throw new InvalidArgumentError(
    '--refuse-unexported-drift requires --build or --build-only: it guards the pre-test build, and this run dispatches none.',
    '--refuse-unexported-drift'
  );
}

/** Renders the `recordedBy` invocation string surfaced by `status --test-coverage`. */
function describeBuildInvocation(extending: boolean, coverage: TestPackagingCoverage): string {
  const extendFlag = extending ? ' --extend-coverage' : '';
  return coverage === 'full'
    ? `fireforge test --build${extendFlag}`
    : `fireforge test --build${extendFlag} ${coverage.join(' ')}`;
}

/**
 * Runs the pre-test build (or the stale-build gate when no build was
 * requested). Returns `true` when the run is COMPLETE — the `--build-only`
 * union-build shape, which packages every requested path
 * (mixed harnesses legal, nothing dispatches), prints the per-harness
 * next steps, and emits the run's single `PASS` verdict.
 */
export async function runTestBuildPhase(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  projectConfig: Awaited<ReturnType<typeof loadConfig>>,
  harnessRetries: number,
  options: TestOptions,
  request: { classification: HarnessClassification; normalizedPaths: string[] }
): Promise<boolean> {
  const { classification, normalizedPaths } = request;
  const extending = options.extendCoverage === true;
  if (extending) {
    assertExtendCoverageUsage(options, normalizedPaths);
  }
  assertRefuseUnexportedDriftUsage(options);
  if (options.build || options.buildOnly) {
    // A path-less `test --build` runs (and packages for) the full suite;
    // a scoped invocation only vouches for the requested paths. A SCOPED
    // rebuild also cannot regenerate the compiled StaticComponents table,
    // so it runs the components.conf gate up-front (the path-less shape
    // refreshes the anchor itself and skips it).
    const coverage: TestPackagingCoverage = normalizedPaths.length === 0 ? 'full' : normalizedPaths;
    if (normalizedPaths.length > 0) {
      const previousBaseline = await readBuildBaseline(projectRoot);
      await enforceStaticComponentsGate(paths.engine, previousBaseline, options);
      if (extending) {
        // Head/fingerprint half of the anchor, before the build lock: a
        // refusal here costs neither build time nor the lock.
        const anchor = await checkExtendCoverageAnchor(paths.engine, previousBaseline);
        if (!anchor.ok) {
          throw new GeneralError(formatExtendCoverageRefusal(anchor));
        }
      }
    }
    await runPreTestBuild(
      projectRoot,
      paths,
      projectConfig,
      harnessRetries,
      coverage,
      options.refuseUnexportedDrift === true,
      extending ? { requestedPaths: normalizedPaths } : undefined
    );
    info('');
    if (options.buildOnly) {
      // Union build for mixed harnesses: the coverage claim
      // above lists every requested path, so each harness half can run
      // build-less against this packaging. Nothing dispatches here; the
      // run still ends with exactly one verdict line.
      reportBuildOnlyCompletion(classification, normalizedPaths);
      emitPassVerdict();
      return true;
    }
  } else {
    await enforceStaleBuildGate(projectRoot, paths.engine, options, normalizedPaths);
  }
  return false;
}
