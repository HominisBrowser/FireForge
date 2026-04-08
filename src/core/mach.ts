// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { MachNotFoundError } from '../errors/build.js';
import { pathExists } from '../utils/fs.js';
import { exec, execInherit, execInheritCapture, execStream } from '../utils/process.js';
import { getPython } from './mach-python.js';

// Re-export sub-modules so existing `from './mach.js'` imports keep working.
export {
  type BuildArtifactCheck,
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
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
 * Runs a mach command while streaming output to the terminal and capturing it
 * for post-run diagnostics.
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
      process.stdout.write(data);
    },
    onStderr: (data) => {
      stderr += data;
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
 * Runs a full mach build.
 * @param engineDir - Path to the engine directory
 * @param jobs - Number of parallel jobs (optional)
 * @returns Exit code
 */
export async function build(engineDir: string, jobs?: number): Promise<number> {
  const args = ['build'];

  if (jobs !== undefined) {
    args.push('-j', String(jobs));
  }

  return runMach(args, engineDir, { inherit: true });
}

/**
 * Runs a fast UI-only build.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function buildUI(engineDir: string): Promise<number> {
  return runMach(['build', 'faster'], engineDir, { inherit: true });
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
 * Creates a distribution package.
 * @param engineDir - Path to the engine directory
 * @returns Exit code
 */
export async function machPackage(engineDir: string): Promise<number> {
  return runMach(['package'], engineDir, { inherit: true });
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
