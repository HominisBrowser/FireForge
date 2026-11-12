// SPDX-License-Identifier: EUPL-1.2
/**
 * The one way `mach` is run. Every caller (build, test, run, package,
 * bootstrap) gets the same process handling: the interpreter the engine
 * accepts, the resource-monitor guard, a process group that is torn down with
 * the command, and output streamed line by line.
 *
 * The process tree belongs to the workspace for as long as `runMach` runs:
 * a descendant that left mach's process group but runs from the engine or
 * the object directory (a browser that started a session of its own) is
 * still terminated when mach ends, so no process of the run outlives the
 * caller's hold on the workspace.
 *
 * Output has two consumers that must not be confused. `onLine` receives every
 * raw line, for a caller that classifies output. The operator sees every line
 * on stderr: stdout belongs to the command's result.
 */
import { join } from 'node:path';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { exists, realPath } from '../kernel/fs.js';
import { info, warn } from '../kernel/log.js';
import { run } from '../kernel/process/index.js';
import { machErrorHints } from './machHints.js';
import { machPython } from './python.js';
import { installResourceGuard } from './resourceGuard.js';
import type { Workspace } from './workspace.js';

/** Which of mach's output streams a line came from. */
export type MachStream = 'stdout' | 'stderr';

/** How one `mach` command is run. */
export interface MachOptions {
  /** Merged over this process's environment. An `undefined` value removes the variable. */
  env?: Readonly<Record<string, string | undefined>>;
  /**
   * Hand mach the terminal (stdin included) instead of streaming its output:
   * for commands that prompt, like `bootstrap`. Nothing is captured, and
   * `onLine` sees nothing.
   */
  terminal?: boolean;
  /** Receives every complete raw output line as it arrives. */
  onLine?: (line: string, stream: MachStream) => void;
  /** Deadline in milliseconds. Past it the process tree is terminated and the result says `timedOut`. */
  timeoutMs?: number;
  /** Teardown the caller owns, awaited after the tree's and before `runMach` settles. */
  afterExit?: () => Promise<void>;
  /** Print the known remedy for a recognised failure (default true). */
  hints?: boolean;
}

async function realPathIfExists(path: string): Promise<string> {
  return (await exists(path)) ? realPath(path) : path;
}

/** How a `mach` command ended. A non-zero exit is a result, not an exception. */
export interface MachResult {
  exitCode: number;
  /** Everything mach wrote, raw. Empty with `terminal`. */
  stdout: string;
  stderr: string;
  /** The deadline passed and mach was terminated for it. */
  timedOut: boolean;
  /** How many processes mach left running that were terminated after it. */
  outlived: number;
}

/**
 * Runs `mach <args>` in a workspace's engine.
 *
 * @param workspace - The workspace
 * @param args - The mach command and its arguments
 * @param options - See {@link MachOptions}
 * @throws `engine-missing` when the engine has no `mach`, `python-not-found`
 *   (exit code 7) when no Python mach accepts is installed
 */
export async function runMach(
  workspace: Pick<Workspace, 'engineDir' | 'objDir' | 'releaseObjDir'>,
  args: readonly string[],
  options: MachOptions = {}
): Promise<MachResult> {
  const { engineDir } = workspace;
  const mach = join(engineDir, 'mach');
  if (!(await exists(mach))) {
    throw new FireForgeError('engine-missing', `There is no mach in ${engineDir}`, {
      exitCode: ExitCode.GENERAL_ERROR,
      hint: 'Run "fireforge download", or "fireforge workspace repair <name>" for a pool workspace.',
    });
  }
  const python = await machPython(engineDir);
  const guard = await installResourceGuard(engineDir, {
    objDirs: [workspace.releaseObjDir],
    env: { ...process.env, ...options.env },
  });
  // A command line may name either spelling of a directory behind a symlink.
  const roots = [engineDir, workspace.objDir, workspace.releaseObjDir];
  const anchors = [...new Set([...roots, ...(await Promise.all(roots.map(realPathIfExists)))])];
  const result = await run(python, [mach, ...args], {
    cwd: engineDir,
    env: { ...guard, ...options.env },
    output: options.terminal === true ? 'inherit' : 'capture',
    processGroup: true,
    timeoutIsResult: true,
    onLine: (line, stream) => {
      options.onLine?.(line, stream);
      info(line);
    },
    onProcessGroup: (owner) => {
      owner.anchorTo(anchors);
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.afterExit === undefined ? {} : { afterExit: options.afterExit }),
  });
  if (result.exitCode !== 0 && options.hints !== false) {
    // mach's wrapper writes a subcommand's errors to either stream.
    for (const hint of machErrorHints(`${result.stderr}\n${result.stdout}`)) warn(`Hint: ${hint}`);
  }
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    outlived: result.outlived,
  };
}

/**
 * The failure of a `mach` command whose success the caller needs.
 *
 * @param command - What ran, such as `mach build`
 * @param result - How it ended
 * @param hint - What to do next
 */
export function machFailure(command: string, result: MachResult, hint?: string): FireForgeError {
  const how = result.timedOut ? 'timed out' : `exited ${result.exitCode}`;
  return new FireForgeError('mach-failed', `${command} ${how}`, {
    exitCode: ExitCode.BUILD_ERROR,
    ...(hint === undefined ? {} : { hint }),
  });
}
