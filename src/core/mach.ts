// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { MachNotFoundError } from '../errors/build.js';
import { pathExists } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import {
  exec,
  execInherit,
  execInheritCapture,
  execSmokeRun,
  execStream,
  type SmokeLineCallback,
  type SmokeRunResult,
} from '../utils/process.js';
import { explainMachError } from './mach-error-hints.js';
import { getPython } from './mach-python.js';

// Re-export sub-modules so existing `from './mach.js'` imports keep working.
export {
  attemptMozinfoRewrite,
  type BuildArtifactCheck,
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  hasRunnableBundle,
  type MozinfoRewriteResult,
  type RunnableBundleCheck,
} from './mach-build-artifacts.js';
export { generateMozconfig, type MozconfigVariables } from './mach-mozconfig.js';
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

  const machPath = join(engineDir, 'mach');

  const execOptions = {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
  };

  if (options.inherit) {
    return execInherit(python, [machPath, ...args], execOptions);
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

  const machPath = join(engineDir, 'mach');
  let stdout = '';
  let stderr = '';

  const exitCode = await execStream(python, [machPath, ...args], {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
    onStdout: (data) => {
      stdout += data;
      if (stdout.length > CAPTURE_TAIL_LIMIT) {
        stdout = stdout.slice(-CAPTURE_TAIL_LIMIT);
      }
      process.stdout.write(data);
    },
    onStderr: (data) => {
      stderr += data;
      if (stderr.length > CAPTURE_TAIL_LIMIT) {
        stderr = stderr.slice(-CAPTURE_TAIL_LIMIT);
      }
      process.stderr.write(data);
    },
  });

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

  const machPath = join(engineDir, 'mach');

  return execInheritCapture(python, [machPath, ...args], {
    cwd: engineDir,
    ...(options.env ? { env: options.env } : {}),
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
 * Prints any matched {@link MachErrorHint} hints for the captured stderr.
 * No-op when nothing matches. Always called before a non-zero exit propagates
 * so the hint sits immediately below the raw mach error in the operator's
 * terminal.
 */
function surfaceMachErrorHints(stderr: string): void {
  const hints = explainMachError(stderr);
  if (hints.length === 0) return;
  for (const hint of hints) {
    warn(`Hint: ${hint}`);
  }
}

/**
 * Runs a full mach build. On a non-zero exit, any matched error hints are
 * surfaced on top of the raw mach output so operators get an actionable
 * nudge alongside the cryptic mozbuild traceback.
 * @param engineDir - Path to the engine directory
 * @param jobs - Number of parallel jobs (optional)
 * @returns Exit code
 */
export async function build(engineDir: string, jobs?: number): Promise<number> {
  const args = ['build'];

  if (jobs !== undefined) {
    args.push('-j', String(jobs));
  }

  const result = await runMachInheritCapture(args, engineDir);
  if (result.exitCode !== 0) {
    surfaceMachErrorHints(result.stderr);
  }
  return result.exitCode;
}

/**
 * Runs a fast UI-only build. On a non-zero exit, any matched error hints are
 * surfaced on top of the raw mach output.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function buildUI(engineDir: string): Promise<number> {
  const result = await runMachInheritCapture(['build', 'faster'], engineDir);
  if (result.exitCode !== 0) {
    surfaceMachErrorHints(result.stderr);
  }
  return result.exitCode;
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
 * @param engineDir - Path to the engine directory
 * @returns Captured output and exit code
 */
export async function watchWithOutput(engineDir: string): Promise<MachCommandResult> {
  return runMachInheritCapture(['watch'], engineDir);
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
 * Runs mach test while capturing streamed output for better diagnostics.
 */
export async function testWithOutput(
  engineDir: string,
  testPaths: string[] = [],
  args: string[] = []
): Promise<MachCommandResult> {
  return runMachCapture(['test', ...testPaths, ...args], engineDir);
}
