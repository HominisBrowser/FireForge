// SPDX-License-Identifier: EUPL-1.2
import { resolve } from 'node:path';

import type { Command } from '../cli/command.js';
import { runProgram } from '../cli/program.js';
import { program } from '../commands/index.js';
import {
  type ProcessResult,
  REPO_ROOT,
  type ScriptOptions,
  type StartedProcess,
  startScript,
} from './script.js';

/** What one CLI invocation produced. */
export type CliResult = ProcessResult;

/** How a test invokes the CLI. */
export type CliRunOptions = ScriptOptions;

/**
 * Runs the CLI inside the test process: fast, and failures carry real stack
 * traces. stdout, stderr and the exit code are captured exactly as a shell
 * would see them, but nothing that needs a real process boundary (signals,
 * the exit itself) is exercised; use {@link spawnCli} for that.
 *
 * @param args - Arguments after `fireforge`
 * @param options - See {@link CliRunOptions}; `commands` replaces the real command list
 */
export async function runCli(
  args: readonly string[],
  options: CliRunOptions & { commands?: readonly Command[] }
): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runProgram(
    { ...program, commands: options.commands ?? program.commands },
    {
      argv: args,
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      interactive: false,
    }
  );
  return { exitCode, stdout, stderr };
}

/**
 * Starts the real entry point (`bin/fireforge.ts`) in a child process.
 *
 * @param args - Arguments after `fireforge`
 * @param options - See {@link CliRunOptions}
 */
function startCli(args: readonly string[], options: CliRunOptions): StartedProcess {
  return startScript(resolve(REPO_ROOT, 'bin/fireforge.ts'), args, options);
}

/**
 * Runs the real entry point in a child process to completion, for what only
 * a process boundary shows: the exit code, the stdout/stderr split, draining.
 *
 * @param args - Arguments after `fireforge`
 * @param options - See {@link CliRunOptions}
 */
export function spawnCli(args: readonly string[], options: CliRunOptions): Promise<CliResult> {
  return startCli(args, options).result;
}
