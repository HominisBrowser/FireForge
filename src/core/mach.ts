// SPDX-License-Identifier: EUPL-1.2
import { basename, join } from 'node:path';

import { MachNotFoundError } from '../errors/build.js';
import { pathExists } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import {
  exec,
  execInherit,
  execInheritCapture,
  execSmokeRun,
  execStream,
  type SmokeLineCallback,
  type SmokeRunResult,
} from '../utils/process.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';
import { ensureFirefoxIgnorefileCompatibility } from './firefox-ignorefile.js';
import { explainMachError } from './mach-error-hints.js';
import {
  createKnownTeardownNoiseFilter,
  createTeardownNoiseContext,
  hasKnownTeardownNoise,
  KNOWN_TEARDOWN_NOISE_BUILD_NOTE,
} from './mach-known-noise-filter.js';
import { getPython } from './mach-python.js';
import { installMachResourceGuard } from './mach-resource-shim.js';
import { teeToRunLog, writeToActiveRunLog } from './run-log.js';
import { detectHarnessCrashSignature, type HarnessCrashSignature } from './test-harness-crash.js';

// Re-export sub-modules so existing `from './mach.js'` imports keep working.
// This block is a frozen compatibility list, not a barrel to grow: every name
// here already had a `from './mach.js'` import when the module was split.
// New helpers belong in their own sub-module and are imported from it
// directly — adding to this list pulls the whole sub-module into every suite
// that mocks `mach.js`.
export {
  attemptMozinfoRewrite,
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  hasRunnableBundle,
} from './mach-build-artifacts.js';
export { generateMozconfig } from './mach-mozconfig.js';
export { ensurePython, resetResolvedPython } from './mach-python.js';

/**
 * Ensures mach is available in the engine directory.
 * @param engineDir - Path to the engine directory
 * @throws MachNotFoundError if mach is not found
 */
export async function ensureMach(engineDir: string): Promise<void> {
  const machPath = join(engineDir, 'mach');

  if (!(await pathExists(machPath))) {
    throw new MachNotFoundError(engineDir);
  }
}

/**
 * Options for running mach commands.
 */
export interface MachOptions {
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Whether to inherit stdio (show output directly) */
  inherit?: boolean;
  /**
   * Collapse the KNOWN mozsystemmonitor teardown traceback to one labeled
   * line in the terminal ECHO (capture-only option). The captured
   * stdout/stderr stay raw — the harness classifier depends on the raw
   * traceback. Unrecognized tracebacks always echo verbatim. Opted into by
   * the test dispatchers only.
   *
   * Consumed by {@link runMachCapture} ALONE. `runMachInheritCapture` accepts
   * it in the type and ignores it — the inherit path has no per-chunk hook,
   * only a mirror stream that feeds the terminal and the run log the same
   * string, so filtering there would strip the traceback from the raw log
   * too. The build path uses the recognition NOTE instead; see
   * `mach-known-noise-filter.ts`.
   */
  annotateKnownTeardownNoise?: boolean;
  /**
   * Environment variables to unset for this dispatch. Threaded to the exec
   * layer's {@link ExecOptions.envUnset}.
   */
  envUnset?: readonly string[];
}

/**
 * Result of running a mach command while capturing streamed output.
 */
export interface MachCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs a mach command in the engine directory.
 * @param args - mach command and arguments
 * @param engineDir - Path to the engine directory
 * @param options - Command options
 * @returns Exit code
 */
export async function runMach(
  args: string[],
  engineDir: string,
  options: MachOptions = {}
): Promise<number> {
  const python = await getPython(engineDir);
  await ensureMach(engineDir);
  await ensureFirefoxIgnorefileCompatibility(engineDir);

  const machPath = join(engineDir, 'mach');

  const execOptions = {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
  };

  if (options.inherit) {
    // Group-reap every long-lived inherited mach dispatch (bootstrap, run,
    // watch): a mach dying at startup must not strand multiprocessing
    // workers. Short-lived metadata queries below stay on plain exec() —
    // adding groups there would touch every non-mach exec consumer's path
    // for no reaping benefit.
    return execInherit(python, [machPath, ...args], { ...execOptions, processGroup: true });
  }

  const result = await exec(python, [machPath, ...args], execOptions);

  return result.exitCode;
}

/**
 * Maximum bytes retained per stream in `runMachCapture`. Only the tail of
 * output is kept so long-lived processes (Storybook, `mach build`) do not
 * grow the Node heap without bound. 2 MB is enough for post-run error
 * diagnosis while staying well below the 50 MB cap in `createStreamCollector`.
 */
const CAPTURE_TAIL_LIMIT = 2 * 1024 * 1024;

/**
 * Runs a mach command while streaming output to the terminal and capturing
 * the tail of stdout/stderr for post-run diagnostics. Output beyond
 * {@link CAPTURE_TAIL_LIMIT} is discarded from the head to prevent unbounded
 * memory growth during long-lived processes like Storybook.
 */
export async function runMachCapture(
  args: string[],
  engineDir: string,
  options: Omit<MachOptions, 'inherit'> = {}
): Promise<MachCommandResult> {
  const python = await getPython(engineDir);
  await ensureMach(engineDir);
  await ensureFirefoxIgnorefileCompatibility(engineDir);

  const machPath = join(engineDir, 'mach');
  let stdout = '';
  let stderr = '';

  // Echo-path filters only: the captured strings above accumulate RAW so the
  // classifier still sees the full teardown traceback. When the option is
  // off, the filters are absent and echo is a straight write (unchanged).
  // One shutdown context per run, shared by both stream filters: the
  // SUITE_END marker usually arrives on stdout while the teardown traceback
  // lands on stderr, so the shutdown-seen flag must span the pair.
  const noiseContext =
    options.annotateKnownTeardownNoise === true ? createTeardownNoiseContext() : undefined;
  const stdoutFilter = noiseContext && createKnownTeardownNoiseFilter(noiseContext);
  const stderrFilter = noiseContext && createKnownTeardownNoiseFilter(noiseContext);

  const exitCode = await execStream(python, [machPath, ...args], {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
    ...(options.envUnset ? { envUnset: options.envUnset } : {}),
    // Every capture dispatch (test suites, protected builds, package,
    // storybook) runs as a process-group leader and is group-reaped on
    // exit/abort — see ExecOptions.processGroup.
    processGroup: true,
    onStdout: (data) => {
      stdout += data;
      if (stdout.length > CAPTURE_TAIL_LIMIT) {
        stdout = stdout.slice(-CAPTURE_TAIL_LIMIT);
      }
      // RAW into the log, filtered into the echo. The log exists to be
      // re-read after the fact by whoever is diagnosing the run, and the
      // echo filter's whole purpose is to shorten what a HUMAN scrolls
      // past — collapsing a traceback in the artifact would reintroduce
      // the loss this log exists to prevent.
      writeToActiveRunLog(data);
      process.stdout.write(stdoutFilter ? stdoutFilter.transform(data) : data);
    },
    onStderr: (data) => {
      stderr += data;
      if (stderr.length > CAPTURE_TAIL_LIMIT) {
        stderr = stderr.slice(-CAPTURE_TAIL_LIMIT);
      }
      writeToActiveRunLog(data);
      process.stderr.write(stderrFilter ? stderrFilter.transform(data) : data);
    },
  });

  if (stdoutFilter) {
    const residue = stdoutFilter.flush();
    if (residue.length > 0) process.stdout.write(residue);
  }
  if (stderrFilter) {
    const residue = stderrFilter.flush();
    if (residue.length > 0) process.stderr.write(residue);
  }

  return { stdout, stderr, exitCode };
}

/**
 * Runs a mach command while inheriting stdin, streaming output live, and
 * capturing stdout/stderr for post-run diagnostics.
 */
export async function runMachInheritCapture(
  args: string[],
  engineDir: string,
  options: Omit<MachOptions, 'inherit'> = {}
): Promise<MachCommandResult> {
  const python = await getPython(engineDir);
  await ensureMach(engineDir);
  await ensureFirefoxIgnorefileCompatibility(engineDir);

  const machPath = join(engineDir, 'mach');

  return execInheritCapture(python, [machPath, ...args], {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
    ...(options.envUnset ? { envUnset: options.envUnset } : {}),
    // This path streams through the collectors' mirror rather than per-chunk
    // callbacks, so the run-log tee rides the mirror. `mach build` is here.
    mirror: { stdout: teeToRunLog(process.stdout), stderr: teeToRunLog(process.stderr) },
    processGroup: true,
  });
}

/**
 * Runs mach bootstrap to install build dependencies.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function bootstrap(engineDir: string): Promise<number> {
  return runMach(['bootstrap', '--application-choice', 'browser'], engineDir, { inherit: true });
}

/**
 * Runs mach bootstrap while preserving stdin and capturing the emitted output.
 * @param engineDir - Path to the engine directory
 * @returns Captured output and exit code
 */
export async function bootstrapWithOutput(engineDir: string): Promise<MachCommandResult> {
  return runMachInheritCapture(['bootstrap', '--application-choice', 'browser'], engineDir);
}

/**
 * Prints any matched {@link MachErrorHint} hints for the captured mach
 * output. No-op when nothing matches. Always called before a non-zero exit
 * propagates so the hint sits immediately below the raw mach error in the
 * operator's terminal.
 *
 * The scanner is passed the concatenation of stderr AND stdout because mach
 * streams its subcommand output through a timestamp-prefixing wrapper that
 * writes both streams to whatever FD the subprocess chose — `rustc` errors
 * from `mach build` can land on stdout, so feeding only `result.stderr`
 * silently loses the match.
 */
function surfaceMachErrorHints(result: MachCommandResult): void {
  const combined = `${result.stderr}\n${result.stdout}`;
  const hints = explainMachError(combined);
  if (hints.length === 0) return;
  for (const hint of hints) {
    warn(`Hint: ${hint}`);
  }
}

/**
 * Uniform recognized-crash retry budget for the protected mach build
 * dispatches (`fireforge build`, `build --ui`, and the pre-test `--build`
 * step). Matches the test harness default so every mach dispatch retries
 * the same crash family the same number of times.
 */
const DEFAULT_BUILD_CRASH_RETRIES = 2;

/** Which mach build entry a protected dispatch runs. */
export type ProtectedBuildKind = 'full' | 'faster';

/** Options for {@link runProtectedMachBuild}. */
export interface ProtectedMachBuildOptions {
  /** Parallel jobs for the full build (ignored for `faster`). */
  jobs?: number | undefined;
  /** Recognized-crash retry budget (0 disables retries). */
  retries?: number | undefined;
  /** Called before each retry with the detected crash signature. */
  onRetry?: (signature: HarnessCrashSignature, nextAttempt: number, maxAttempts: number) => void;
}

/** Captured result of a protected (guarded, retried) mach build dispatch. */
export interface ProtectedMachBuildResult extends MachCommandResult {
  /** How many mach processes were spawned (1 = no retry needed). */
  attempts: number;
  /** Crash signature of the final failed attempt, when recognized. */
  crashSignature?: HarnessCrashSignature;
}

/**
 * Names the known mozsystemmonitor teardown traceback when a BUILD carried
 * it. The test path collapses this signature in the echo; a build cannot
 * (see `mach-known-noise-filter.ts`), so it reached operators as an
 * unexplained traceback in a build log — a recognized, documented upstream
 * defect wearing the appearance of a new one. The output is left verbatim
 * and this one line is added beside it, so the same signature reads the same
 * in both phases.
 */
function noteKnownTeardownNoiseInBuild(result: { stdout: string; stderr: string }): void {
  if (!hasKnownTeardownNoise(`${result.stdout}\n${result.stderr}`)) return;
  info(KNOWN_TEARDOWN_NOISE_BUILD_NOTE);
}

/**
 * The single protected path every FireForge mach build dispatch routes
 * through — `build`, `build --ui`, and the pre-test `--build` step all use
 * it, so no entry point is left unprotected with a different retry budget:
 *
 *  1. installs the resource-monitor degrade guard IN the mach virtualenvs
 *     (plus the PYTHONPATH fallback) — re-installed before every attempt, so
 *     a venv materialized by a crashed first attempt is guarded on the next
 *     one instead of every retry dying on the same wedged state;
 *  2. spawns a fresh mach process per attempt;
 *  3. retries ONLY the recognized harness-crash family (resource monitor /
 *     psutil startup tracebacks) up to the uniform budget — an ordinary
 *     compile error is never retried.
 *
 * The protected path never runs `mach configure`, never clobbers, and never
 * widens the requested build kind — a `faster` dispatch retries as
 * `mach build faster`, so it cannot invalidate more of the objdir than the
 * command the operator asked for.
 */
export async function runProtectedMachBuild(
  kind: ProtectedBuildKind,
  engineDir: string,
  options: ProtectedMachBuildOptions = {}
): Promise<ProtectedMachBuildResult> {
  const args = kind === 'faster' ? ['build', 'faster'] : ['build'];
  if (kind === 'full' && options.jobs !== undefined) {
    args.push('-j', String(options.jobs));
  }

  const maxAttempts = Math.max(1, (options.retries ?? DEFAULT_BUILD_CRASH_RETRIES) + 1);
  for (let attempt = 1; ; attempt += 1) {
    const { env } = await installMachResourceGuard(engineDir);
    const result = await runMachInheritCapture(args, engineDir, { env });
    if (result.exitCode === 0) {
      noteKnownTeardownNoiseInBuild(result);
      return { ...result, attempts: attempt };
    }

    const signature = detectHarnessCrashSignature(`${result.stdout}\n${result.stderr}`);
    if (signature && attempt < maxAttempts) {
      options.onRetry?.(signature, attempt + 1, maxAttempts);
      warn(
        `mach ${kind === 'faster' ? 'build faster' : 'build'} hit a recognized harness crash ` +
          `(${signature.reason}): ${signature.line}\n` +
          `Retrying with a fresh process (attempt ${attempt + 1} of ${maxAttempts})...`
      );
      continue;
    }

    surfaceMachErrorHints(result);
    noteKnownTeardownNoiseInBuild(result);
    return { ...result, attempts: attempt, ...(signature ? { crashSignature: signature } : {}) };
  }
}

/**
 * Runs a full mach build through the protected dispatch path (resource
 * guard + recognized-crash retries). On a non-zero exit, any matched error
 * hints are surfaced on top of the raw mach output so operators get an
 * actionable nudge alongside the cryptic mozbuild traceback. Returns the
 * captured result so the caller (e.g. `fireforge build`) can inspect the
 * tail for post-build diagnostics that mach prints AFTER "Your build was
 * successful!" — notably the stale `config.status is out of date`
 * notice that mach emits when a tool-managed edit landed on
 * `moz.configure` before the build.
 * @param engineDir - Path to the engine directory
 * @param jobs - Number of parallel jobs (optional)
 * @returns Captured mach result (stdout tail, stderr tail, exit code)
 */
export async function build(engineDir: string, jobs?: number): Promise<ProtectedMachBuildResult> {
  return runProtectedMachBuild('full', engineDir, { jobs });
}

/**
 * Runs a fast UI-only build through the same protected dispatch path as
 * {@link build}. See {@link build} for why the full captured result is
 * returned rather than just the exit code.
 * @param engineDir - Path to the engine directory
 * @returns Captured mach result
 */
export async function buildUI(engineDir: string): Promise<ProtectedMachBuildResult> {
  return runProtectedMachBuild('faster', engineDir);
}

/**
 * Runs an operation while holding a sidecar build lock keyed on the project
 * root. Concurrent `fireforge build` / `fireforge build --ui` invocations
 * against the same tree serialise instead of racing through the mach
 * obj-dir.
 *
 * Without it, a `build --ui` started while a full `build` is still in flight
 * hands off to `mach build faster` and fails almost immediately with `No
 * rule to make target 'XUL'` — the real problem being that the first build
 * has not yet materialised the full backend, with nothing in the low-level
 * make error pointing at the concurrent run. The lock intercepts the second
 * invocation before it touches mach, and the refusal names the PID holding
 * the lock so the operator can decide whether to wait or investigate.
 *
 * Stale-lock recovery: the lock stores the owner PID; a crashed build
 * (SIGINT, SIGTERM, or a kernel kill) leaves the lock dir behind but not the
 * owning process, and `withFileLock` removes the lock on the next attempt
 * when `process.kill(pid, 0)` shows the owner is gone.
 *
 * The project-root variant is the right granularity: a single machine may
 * have several FireForge projects side by side and nothing says they cannot
 * build in parallel. The lock serialises *within* one project.
 *
 * Returns whatever the inner operation returns.
 */
export async function withBuildLock<T>(
  projectRoot: string,
  operation: () => Promise<T>
): Promise<T> {
  const lockPath = createSiblingLockPath(join(projectRoot, '.fireforge-build'), '.lock');
  return withFileLock(lockPath, operation, {
    // Default lock timeout is 30s; bump to 24h so a slow full build does
    // not trip the timeout while the second invocation waits. A real
    // operator will ^C long before 24h elapses; the ceiling is there
    // purely so a forgotten lock cannot wedge the command forever.
    timeoutMs: 24 * 60 * 60 * 1000,
    onTimeoutMessage:
      `Timed out waiting for the FireForge build lock at ${lockPath}. ` +
      'If no other `fireforge build` is running, remove the lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge build lock ${basename(lockPath)} (age: ${Math.round(ageMs / 1000)}s). A previous build process may have crashed.`,
  });
}

/**
 * Runs the built browser.
 * @param engineDir - Path to the engine directory
 * @param args - Additional arguments to pass to the browser
 * @returns Exit code
 */
export async function run(engineDir: string, args: string[] = []): Promise<number> {
  return runMach(['run', ...args], engineDir, { inherit: true });
}

/**
 * Options for {@link runMachSmoke}.
 */
export interface RunMachSmokeOptions {
  env?: Record<string, string>;
  smokeTimeoutMs: number;
  killGraceMs?: number;
  onStdoutLine?: SmokeLineCallback;
  onStderrLine?: SmokeLineCallback;
  mirror?: { stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream };
}

/**
 * Launches `mach run` under the smoke-run wrapper: streams line-by-line,
 * enforces a deadline by SIGTERMing the whole process group, and returns
 * the captured output alongside a `timedOut` flag.
 *
 * Unlike {@link run}, this variant does NOT inherit stdio. The child
 * stdout/stderr are piped back through the line callbacks so the caller
 * can scan for `JavaScript error:` / `console.error:` without coupling
 * the runner to chrome-specific pattern logic.
 */
export async function runMachSmoke(
  args: string[],
  engineDir: string,
  options: RunMachSmokeOptions
): Promise<SmokeRunResult> {
  const python = await getPython(engineDir);
  await ensureMach(engineDir);
  await ensureFirefoxIgnorefileCompatibility(engineDir);
  const machPath = join(engineDir, 'mach');
  return execSmokeRun(python, [machPath, ...args], {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
    smokeTimeoutMs: options.smokeTimeoutMs,
    ...(options.killGraceMs !== undefined ? { killGraceMs: options.killGraceMs } : {}),
    ...(options.onStdoutLine ? { onStdoutLine: options.onStdoutLine } : {}),
    ...(options.onStderrLine ? { onStderrLine: options.onStderrLine } : {}),
    ...(options.mirror ? { mirror: options.mirror } : {}),
  });
}

/**
 * Creates a distribution package.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function machPackage(engineDir: string): Promise<number> {
  return runMach(['package'], engineDir, { inherit: true });
}

/**
 * Creates a distribution package while streaming output to the terminal
 * and capturing the stderr tail for post-run diagnostics. Callers that
 * want to consult {@link explainMachError} on failure should use this
 * variant; the inherit-only `machPackage` above remains for callers that
 * just need an exit code.
 *
 * @param engineDir - Path to the engine directory
 * @returns Captured mach result (stdout tail, stderr tail, exit code)
 */
export async function machPackageCapture(engineDir: string): Promise<MachCommandResult> {
  return runMachCapture(['package'], engineDir);
}

/**
 * Runs mach watch for auto-rebuilding.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function watch(engineDir: string): Promise<number> {
  return runMach(['watch'], engineDir, { inherit: true });
}

/**
 * Runs mach watch while preserving stdin and capturing emitted output.
 *
 * `env` is threaded through so the caller can prepend the resolved watchman
 * directory to PATH in a way mach inherits: `fireforge watch` can locate
 * `watchman` via `which`, but the mach subprocess spawns with the parent's
 * PATH only — on macOS that typically omits `/opt/homebrew/bin`, so
 * `mach watch` fails at the `watch-project` subscription step.
 *
 * @param engineDir - Path to the engine directory
 * @param options - Optional environment overrides merged into the mach
 *   subprocess env
 * @returns Captured output and exit code
 */
export async function watchWithOutput(
  engineDir: string,
  options: { env?: Record<string, string> } = {}
): Promise<MachCommandResult> {
  return runMachInheritCapture(['watch'], engineDir, options.env ? { env: options.env } : {});
}

/**
 * Runs mach test with the given test paths.
 * @param engineDir - Path to the engine directory
 * @param testPaths - Test file or directory paths (relative to engine)
 * @param args - Additional arguments to pass to mach test
 * @returns Exit code
 */
export async function test(
  engineDir: string,
  testPaths: string[] = [],
  args: string[] = []
): Promise<number> {
  return runMach(['test', ...testPaths, ...args], engineDir, { inherit: true });
}

/**
 * Environment markers mozbuild reads to decide it is running under a coding
 * agent (`mozbuild.util.is_running_under_coding_agent`), which quiets
 * terminal output to warnings and errors.
 *
 * The quieting is genuinely useful for BUILDS — that is most of what an
 * agent session prints — but it applies to test runs too, where it removes
 * `TEST_START` and console INFO: exactly the lines a hang or stall
 * diagnosis needs, and the ones FireForge's own classifier reads
 * (`Ran N checks`, `Unexpected results:`, `TEST-UNEXPECTED-*`). Unsetting
 * the variable globally would give up the build half as well, so the
 * dispatchers below unset it per TEST dispatch and leave the build path
 * alone.
 */
const CODING_AGENT_ENV_MARKERS = ['CLAUDECODE'] as const;

/**
 * The `envUnset` list for a test dispatch: the coding-agent markers when
 * full verbosity was requested, nothing otherwise.
 *
 * Opt-in rather than unconditional: this changes how much a third party
 * prints, and an operator who wants mozbuild's quieting should keep it.
 */
function testVerbosityEnvUnset(fullOutput: boolean | undefined): readonly string[] | undefined {
  return fullOutput === true ? CODING_AGENT_ENV_MARKERS : undefined;
}

/**
 * Runs mach test while capturing streamed output for better diagnostics.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @param testPaths - Test paths to pass to `mach test`; empty runs the default set
 * @param args - Extra `mach test` arguments appended after the paths
 * @param env - Optional extra environment variables for the mach process
 *   (merged over `process.env` by the exec layer). Used by
 *   `fireforge test --perf-samples` to publish the artifact-path contract.
 */
export async function testWithOutput(
  engineDir: string,
  testPaths: string[] = [],
  args: string[] = [],
  env?: Record<string, string>,
  fullOutput?: boolean
): Promise<MachCommandResult> {
  const guard = await installMachResourceGuard(engineDir);
  const envUnset = testVerbosityEnvUnset(fullOutput);
  return runMachCapture(['test', ...testPaths, ...args], engineDir, {
    env: { ...guard.env, ...env },
    ...(envUnset ? { envUnset } : {}),
    annotateKnownTeardownNoise: true,
  });
}

/**
 * Runs `mach xpcshell-test` (the suite-specific xpcshell command) while
 * capturing output. Unlike the generic `mach test`, the suite-specific
 * commands degrade a broken mozlog resource monitor to a warning instead of
 * crashing at startup, so `fireforge test` dispatches single-suite runs here
 * to stay resilient to the host psutil failure.
 *
 * Signature mirrors {@link testWithOutput} so the two are interchangeable in
 * the dispatch path.
 */
export async function xpcshellTestWithOutput(
  engineDir: string,
  testPaths: string[] = [],
  args: string[] = [],
  env?: Record<string, string>,
  fullOutput?: boolean
): Promise<MachCommandResult> {
  const guard = await installMachResourceGuard(engineDir);
  const envUnset = testVerbosityEnvUnset(fullOutput);
  return runMachCapture(['xpcshell-test', ...testPaths, ...args], engineDir, {
    env: { ...guard.env, ...env },
    ...(envUnset ? { envUnset } : {}),
    annotateKnownTeardownNoise: true,
  });
}

/**
 * Runs `mach mochitest` (covers browser-chrome / mochitest flavors) while
 * capturing output. The suite-specific counterpart to {@link testWithOutput}
 * for non-xpcshell single-suite runs — see {@link xpcshellTestWithOutput}.
 */
export async function mochitestWithOutput(
  engineDir: string,
  testPaths: string[] = [],
  args: string[] = [],
  env?: Record<string, string>,
  fullOutput?: boolean
): Promise<MachCommandResult> {
  const guard = await installMachResourceGuard(engineDir);
  const envUnset = testVerbosityEnvUnset(fullOutput);
  return runMachCapture(['mochitest', ...testPaths, ...args], engineDir, {
    env: { ...guard.env, ...env },
    ...(envUnset ? { envUnset } : {}),
    annotateKnownTeardownNoise: true,
  });
}
