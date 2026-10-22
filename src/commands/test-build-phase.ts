// SPDX-License-Identifier: EUPL-1.2
/**
 * Pre-test build phase for `fireforge test`, split out of `test.ts` (at
 * the per-file line budget): the incremental protected mach build with
 * its baseline write, and the `--build-only` union-build shape.
 */

import { readBuildBaseline, writeBuildBaseline } from '../core/build-baseline.js';
import type {
  BuildBaseline,
  ControlBuildStamp,
  TestPackagingCoverage,
} from '../core/build-baseline-types.js';
import { prepareBuildEnvironment } from '../core/build-prepare.js';
import {
  applyMozconfigAnchor,
  type CoverageRetentionPlan,
  formatCoverageRetentionNotice,
  formatExtendCoverageRefusal,
  planCoverageRetention,
  type RecordedCoverage,
  recordScopedCoverage,
} from '../core/coverage-extend.js';
import { normalizeRequestPath } from '../core/coverage-records.js';
import { hasBuildArtifacts } from '../core/mach.js';
import { runProtectedMachBuild, withBuildLock } from '../core/mach.js';
import { assertHealthyPartialConfig, pruneDanglingTestLinks } from '../core/objdir-maintenance.js';
import { buildHarnessCrashMessage } from '../core/test-harness-crash.js';
import {
  findCompiledSourcesNewerThanBinary,
  formatStaleCompiledBuildNotice,
} from '../core/test-stale-check.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import type { TestOptions } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { info, notice, spinner, verbose } from '../utils/logger.js';
import { reportPreTestFurnace } from './test-build-furnace.js';
import { partitionReachedComponents, resolveFurnaceApplyMode } from './test-furnace-reach.js';
import type { HarnessClassification } from './test-modes.js';
import { reportBuildOnlyCompletion } from './test-modes.js';
import { enforceStaleBuildGate, enforceStaticComponentsGate } from './test-stale-gate.js';
import { emitPassVerdict } from './test-verdict.js';

/** The Furnace apply a pre-test build runs. */
interface PreTestFurnacePlan {
  /** Skip the apply entirely (`--furnace-apply none`). */
  skip: boolean;
  /** Apply only these components (`reached`); every component when unset. */
  only?: string[];
  /** Components with undeployed edits that `reached` leaves out. */
  unreached?: string[];
}

interface RunPreTestBuildOptions {
  /** Root directory of the project. */
  projectRoot: string;
  /** Resolved project paths. */
  paths: ProjectPaths;
  /** Loaded project configuration. */
  projectConfig: FireForgeConfig;
  /** Harness-crash retry budget for the build. */
  harnessRetries: number;
  /** Coverage claim to record on the baseline this build writes. */
  testPackagingCoverage: TestPackagingCoverage;
  /** Whether unexported engine drift must refuse the build. */
  refuseUnexportedDrift: boolean;
  /** `--extend-coverage` request paths, when the flag is in force. */
  extend?: { requestedPaths: string[] } | undefined;
  /** What the Furnace apply before the build does. */
  furnace: PreTestFurnacePlan;
  /** Forces a full `mach build`, with this notice (a compiled negative control). */
  fullBuildReason?: string | undefined;
  /**
   * Stamp for a build that compiles a negative control in: recorded on the
   * baseline this build writes. See {@link BuildBaseline.controlBuild}.
   */
  controlBuild?: ControlBuildStamp | undefined;
}

/**
 * Runs the incremental pre-test build under the build lock and records the
 * baseline it produced.
 *
 * @param options - See {@link RunPreTestBuildOptions}
 */
async function runPreTestBuild(options: RunPreTestBuildOptions): Promise<void> {
  const {
    projectRoot,
    paths,
    projectConfig,
    harnessRetries,
    testPackagingCoverage,
    refuseUnexportedDrift,
    extend,
    furnace,
    fullBuildReason,
    controlBuild,
  } = options;
  await withBuildLock(projectRoot, async () => {
    // Pass the previous baseline exactly like `fireforge build` does, so
    // auto-configure runs under the same conditions on both paths. The
    // pre-test build must never invalidate more of the objdir than a plain
    // `mach build faster` would: a failed pre-test build followed by a full
    // rebuild is an hour where an incremental one would have sufficed.
    const previousBaseline = await readBuildBaseline(projectRoot);
    const artifacts = await hasBuildArtifacts(paths.engine);
    if (artifacts.objDir) {
      await assertHealthyPartialConfig(paths.engine, artifacts.objDir);
      const pruned = await pruneDanglingTestLinks(paths.engine, artifacts.objDir);
      if (pruned > 0) notice(`Pruned ${pruned} dangling _tests symlink(s).`);
    }
    // The named-file checkJs pass runs before the engine lock is even
    // requested (test-prelock.ts), so a type error refuses without a wait.
    const preparation = await prepareBuildEnvironment(projectRoot, paths, projectConfig, {
      previousBaseline,
      refuseUnexportedDrift,
      skipFurnaceApply: furnace.skip,
      furnaceComponents: furnace.only,
    });
    await reportPreTestFurnace(projectRoot, preparation, furnace.skip, furnace.unreached);

    // Which earlier claims this scoped build keeps, per staged path. The
    // mozconfig half can only be checked once prepareBuildEnvironment has
    // regenerated engine/mozconfig (the file this build will configure
    // with), and must still be checked before mach, so a refusal costs no
    // build.
    let plan: CoverageRetentionPlan | undefined;
    if (testPackagingCoverage !== 'full') {
      plan = await applyMozconfigAnchor(
        paths.engine,
        await planCoverageRetention(paths.engine, previousBaseline, testPackagingCoverage)
      );
      if (extend !== undefined && plan.dropped.length > 0) {
        throw new GeneralError(formatExtendCoverageRefusal(plan.dropped));
      }
      const retentionNotice = formatCoverageRetentionNotice(plan);
      if (retentionNotice !== undefined) notice(retentionNotice);
    }

    const fullBuild = preparation.fullBuildRequired || fullBuildReason !== undefined;
    const buildKind = fullBuild ? 'full' : 'faster';
    if (fullBuild) {
      // Warning severity rather than info: agent-facing output filters
      // keep warnings and errors only, and this is the line that explains an
      // otherwise unexplained multi-minute build.
      notice(
        (preparation.fullBuildRequired ? preparation.fullBuildReason : fullBuildReason) ??
          'A jar.mn registration changed since the last successful build; escalating this pre-test build to a full mach build so new install-manifest destinations are created.'
      );
    }
    const s = spinner(
      fullBuild ? 'Running required full build...' : 'Running incremental build...'
    );
    // The pre-test build routes through the same protected mach dispatch as
    // `fireforge build` / `build --ui`: in-venv resource-monitor guard plus
    // the uniform recognized-crash retry budget, with a fresh mach process
    // (and fresh guard install) per attempt. prepareBuildEnvironment runs
    // once, outside the retry loop. Retries never re-run mach configure.
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
      // carries the static-components anchor forward, since `mach build
      // faster` does not rebake components.conf into the compiled table.
      try {
        // A scoped claim records this build's paths plus every earlier path
        // the plan kept, each with its own staging-input anchor. When it
        // kept anything the static-components anchor is carried forward
        // explicitly: a kept full claim is still a `mach build faster` that
        // did not rebake the compiled table.
        const recorded: RecordedCoverage =
          plan === undefined || testPackagingCoverage === 'full'
            ? { testPackagingCoverage }
            : await recordScopedCoverage(paths.engine, plan, testPackagingCoverage);
        await writeBuildBaseline({
          projectRoot,
          engineDir: paths.engine,
          binaryName: projectConfig.binaryName,
          ...recorded,
          previousBaseline,
          recordedBy: describeBuildInvocation(extend !== undefined, testPackagingCoverage),
          staticComponentsHandling: fullBuild
            ? 'refresh'
            : plan !== undefined && (plan.keepFull || Object.keys(plan.retained).length > 0)
              ? 'carry-forward'
              : 'auto',
          buildKind,
          controlBuild,
        });
      } catch (baselineError: unknown) {
        verbose(`Could not persist build baseline: ${toError(baselineError).message}`);
      }
      return;
    }
    s.error('Pre-test build failed');
    throw new BuildError(
      result.crashSignature
        ? buildHarnessCrashMessage(
            result.crashSignature,
            result.attempts,
            fullBuild ? 'mach build' : 'mach build faster'
          )
        : 'Pre-test build failed',
      fullBuild ? 'mach build' : 'mach build faster'
    );
  });
}

/**
 * `--extend-coverage` only means something for a scoped build: it refuses
 * a build that would drop an earlier claim. Without `--build`/
 * `--build-only` there is no build to extend from, and a path-less build
 * records `'full'`, which already covers everything. Refusing both is more
 * honest than silently ignoring the flag.
 */
function assertExtendCoverageUsage(options: TestOptions, normalizedPaths: string[]): void {
  if (options.build !== true && options.buildOnly !== true) {
    throw new InvalidArgumentError(
      '--extend-coverage requires --build or --build-only: it guards the coverage claim a build records.',
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
 * The flag governs the pre-test build only, so accepting it without
 * `--build`/`--build-only` would arm a belt over work that never happens,
 * the same silent no-op this release fixes elsewhere.
 */
function assertRefuseUnexportedDriftUsage(options: TestOptions): void {
  if (options.refuseUnexportedDrift !== true) return;
  if (options.build === true || options.buildOnly === true) return;
  throw new InvalidArgumentError(
    '--refuse-unexported-drift requires --build or --build-only: it guards the pre-test build, and this run dispatches none.',
    '--refuse-unexported-drift'
  );
}

/** Refuses `--no-furnace-apply`/`--furnace-apply` on a run that dispatches no build, for the same reason. */
function assertNoFurnaceApplyUsage(options: TestOptions): void {
  if (options.furnaceApply === undefined || options.furnaceApply === true) return;
  if (options.build === true || options.buildOnly === true) return;
  const flag = options.furnaceApply === false ? '--no-furnace-apply' : '--furnace-apply';
  throw new InvalidArgumentError(
    `${flag} requires --build or --build-only: it shapes the pre-test build's Furnace apply, and this run dispatches no build.`,
    flag
  );
}

/**
 * The Furnace part of a pre-test build: skip the apply, apply everything,
 * or apply only the components the request reaches (and name the rest).
 */
async function planPreTestFurnace(
  projectRoot: string,
  paths: ProjectPaths,
  projectConfig: FireForgeConfig,
  options: TestOptions,
  normalizedPaths: readonly string[]
): Promise<PreTestFurnacePlan> {
  const mode = resolveFurnaceApplyMode(options, projectConfig);
  if (mode === 'none') return { skip: true };
  // A path-less build packages the whole suite, which reaches everything.
  if (mode === 'all' || normalizedPaths.length === 0) return { skip: false };
  const { reached, skipped } = await partitionReachedComponents(
    projectRoot,
    paths.engine,
    normalizedPaths
  );
  return { skip: false, only: reached, unreached: skipped };
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
 * requested). Returns `true` when the run is complete: the `--build-only`
 * union-build shape, which packages every requested path
 * (mixed harnesses legal, nothing dispatches), prints the per-harness
 * next steps, and emits the run's single `PASS` verdict.
 */
export async function runTestBuildPhase(
  projectRoot: string,
  paths: ProjectPaths,
  projectConfig: FireForgeConfig,
  harnessRetries: number,
  options: TestOptions,
  request: {
    classification: HarnessClassification;
    normalizedPaths: string[];
    /** Forces a full pre-test build (a compiled negative control). */
    fullBuildReason?: string;
    /** Recorded on the pre-test build's baseline (a compiled negative control). */
    controlBuild?: ControlBuildStamp;
    /**
     * Engine-relative launchable binary: anchors the stale-compiled check,
     * which refuses a build-less run and escalates a `--build` one.
     */
    launchablePath?: string | undefined;
  }
): Promise<boolean> {
  const { classification, normalizedPaths, controlBuild, launchablePath } = request;
  const extending = options.extendCoverage === true;
  if (extending) {
    assertExtendCoverageUsage(options, normalizedPaths);
  }
  assertRefuseUnexportedDriftUsage(options);
  assertNoFurnaceApplyUsage(options);
  if (options.build || options.buildOnly) {
    // A path-less `test --build` runs (and packages for) the full suite.
    // A scoped invocation only vouches for the requested paths. A scoped
    // rebuild also cannot regenerate the compiled StaticComponents table,
    // so it runs the components.conf gate up-front (the path-less shape
    // refreshes the anchor itself and skips it).
    // Coverage paths are recorded normalized (no trailing slash, no `./`):
    // the baseline validator refuses the raw `dir/` CLI shape, which would
    // block every later plain `fireforge test`. A request
    // for the engine root (`.`) packages everything, so it records `'full'`.
    const coveragePaths = normalizedPaths.map(normalizeRequestPath);
    const coverage: TestPackagingCoverage =
      coveragePaths.length === 0 || coveragePaths.includes('')
        ? 'full'
        : [...new Set(coveragePaths)];
    if (coverage !== 'full') {
      const previousBaseline = await readBuildBaseline(projectRoot);
      await enforceStaticComponentsGate(paths.engine, previousBaseline, options);
      if (extending) {
        // Staging-input half of the plan, before the build lock: a refusal
        // here costs neither build time nor the lock.
        const plan = await planCoverageRetention(paths.engine, previousBaseline, coverage);
        if (plan.dropped.length > 0) {
          throw new GeneralError(formatExtendCoverageRefusal(plan.dropped));
        }
      }
    }
    const fullBuildReason =
      request.fullBuildReason ??
      (await describeCompiledEscalation(projectRoot, paths.engine, launchablePath));
    await runPreTestBuild({
      projectRoot,
      paths,
      projectConfig,
      harnessRetries,
      testPackagingCoverage: coverage,
      refuseUnexportedDrift: options.refuseUnexportedDrift === true,
      extend: extending && coverage !== 'full' ? { requestedPaths: coverage } : undefined,
      fullBuildReason,
      controlBuild,
      furnace: await planPreTestFurnace(
        projectRoot,
        paths,
        projectConfig,
        options,
        normalizedPaths
      ),
    });
    info('');
    if (options.buildOnly) {
      // Union build for mixed harnesses: the coverage claim
      // above lists every requested path, so each harness half can run
      // build-less against this packaging. Nothing dispatches here. The
      // run still ends with exactly one verdict line.
      reportBuildOnlyCompletion(classification, normalizedPaths);
      emitPassVerdict();
      return true;
    }
  } else {
    await enforceStaleBuildGate(projectRoot, paths.engine, options, normalizedPaths, {
      launchablePath,
    });
  }
  return false;
}

/**
 * Why a `--build` run's pre-test build must be a full `mach build` although
 * nothing asked for one: compiled sources changed after the binary was
 * linked, or the binary still carries a negative control a killed run (or a
 * failed restore build) left compiled in. `mach build faster` compiles
 * nothing, so either would otherwise survive the build.
 */
async function describeCompiledEscalation(
  projectRoot: string,
  engineDir: string,
  launchablePath: string | undefined
): Promise<string | undefined> {
  const baseline: BuildBaseline | undefined = await readBuildBaseline(projectRoot);
  const stale = await findCompiledSourcesNewerThanBinary(engineDir, baseline, launchablePath);
  if (stale !== undefined && stale.paths.length > 0) return formatStaleCompiledBuildNotice(stale);
  const stamp = baseline?.controlBuild;
  if (stamp !== undefined) {
    return (
      `The binary was built with the negative control ${stamp.diffFile} applied and not ` +
      'rebuilt since; escalating this pre-test build to a full mach build so it recompiles ' +
      'the restored source.'
    );
  }
  return undefined;
}
