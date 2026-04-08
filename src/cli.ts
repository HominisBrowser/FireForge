// SPDX-License-Identifier: EUPL-1.2
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { Command } from 'commander';

import { registerBootstrap } from './commands/bootstrap.js';
import { registerBuild } from './commands/build.js';
import { registerConfig } from './commands/config.js';
import { registerDiscard } from './commands/discard.js';
import { registerDoctor } from './commands/doctor.js';
import { registerDownload } from './commands/download.js';
import { registerExport } from './commands/export.js';
import { registerExportAll } from './commands/export-all.js';
import { registerFurnace } from './commands/furnace/index.js';
import { registerImport } from './commands/import.js';
import { registerLint } from './commands/lint.js';
import { registerPackage } from './commands/package.js';
import { registerReExport } from './commands/re-export.js';
import { registerRebase } from './commands/rebase.js';
import { registerRegister } from './commands/register.js';
import { registerReset } from './commands/reset.js';
import { registerResolve } from './commands/resolve.js';
import { registerRun } from './commands/run.js';
import { registerSetup } from './commands/setup.js';
import { registerStatus } from './commands/status.js';
import { registerTest } from './commands/test.js';
import { registerToken } from './commands/token.js';
import { registerWatch } from './commands/watch.js';
import { registerWire } from './commands/wire.js';
import { CancellationError, CommandError, FireForgeError } from './errors/base.js';
import { ExitCode } from './errors/codes.js';
import type { CommandContext } from './types/cli.js';
import { toError } from './utils/errors.js';
import { cancel, error as logError, setVerbose } from './utils/logger.js';
import { getPackageVersion } from './utils/package-root.js';

const brokenPipeInstalledKey = Symbol.for('fireforge.cli.brokenPipeHandlerInstalled');
const brokenPipeListenerKey = Symbol.for('fireforge.cli.brokenPipeHandlerListener');

type FireForgeProcess = NodeJS.Process & {
  [brokenPipeInstalledKey]?: boolean | undefined;
  [brokenPipeListenerKey]?: ((error: NodeJS.ErrnoException) => void) | undefined;
};

function getProcessState(): FireForgeProcess {
  return process as FireForgeProcess;
}

function getBrokenPipeHandler(state: FireForgeProcess): (error: NodeJS.ErrnoException) => void {
  const existingHandler = state[brokenPipeListenerKey];
  if (existingHandler) {
    return existingHandler;
  }

  const handler = (error: NodeJS.ErrnoException): void => {
    if (error.code === 'EPIPE') {
      process.exitCode = 0;
      return;
    }

    throw error;
  };

  state[brokenPipeListenerKey] = handler;
  return handler;
}

/**
 * Installs a handler for broken-pipe (EPIPE) errors on stdout/stderr.
 * This is a process-level concern: when output is piped to a process that
 * closes early (e.g. `fireforge status | head`), Node emits EPIPE.
 * We treat this as a clean exit.
 */
export function installBrokenPipeHandler(): void {
  const state = getProcessState();
  if (state[brokenPipeInstalledKey]) {
    return;
  }

  const handleStreamError = getBrokenPipeHandler(state);
  process.stdout.on('error', handleStreamError);
  process.stderr.on('error', handleStreamError);
  state[brokenPipeInstalledKey] = true;
}

/** Removes the broken-pipe handler installed for CLI tests. */
export function resetBrokenPipeHandlerForTests(): void {
  const state = getProcessState();
  const handleStreamError = state[brokenPipeListenerKey];

  if (handleStreamError) {
    process.stdout.off('error', handleStreamError);
    process.stderr.off('error', handleStreamError);
  }

  state[brokenPipeInstalledKey] = undefined;
  state[brokenPipeListenerKey] = undefined;
}

/**
 * Gets the project root directory.
 * Walks up from the current working directory until a fireforge.json is found.
 * Falls back to the current working directory when no project root is found.
 */
export function getProjectRoot(): string {
  const start = resolve(process.cwd());
  let current = start;

  for (;;) {
    if (existsSync(join(current, 'fireforge.json'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return start;

    current = parent;
  }
}

/**
 * Wraps a command handler with error handling.
 *
 * Logs the user-visible error message and throws a {@link CommandError}
 * carrying the appropriate exit code. The actual `process.exit()` call
 * lives in the CLI entrypoint (`bin/fireforge.ts`), keeping shared library
 * code free of process-terminating side effects.
 */
export function withErrorHandling<T extends unknown[]>(
  handler: (...args: T) => Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    try {
      await handler(...args);
    } catch (error: unknown) {
      if (error instanceof CancellationError) {
        cancel('Operation cancelled');
        throw new CommandError(ExitCode.GENERAL_ERROR);
      }

      if (error instanceof FireForgeError) {
        logError(error.userMessage);
        throw new CommandError(error.code);
      }

      const normalizedError = toError(error);
      logError(`Unexpected error: ${normalizedError.message}`);
      if (normalizedError.stack) {
        console.error(normalizedError.stack);
      }
      throw new CommandError(ExitCode.GENERAL_ERROR);
    }
  };
}

/**
 * Creates and configures the CLI program.
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('fireforge')
    .description('A build tool for customizing Firefox')
    .version(getPackageVersion())
    .option('-v, --verbose', 'Enable debug output')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts['verbose']) {
        setVerbose(true);
      }
    });

  const ctx: CommandContext = { getProjectRoot, withErrorHandling };

  registerSetup(program, ctx);
  registerDownload(program, ctx);
  registerBootstrap(program, ctx);
  registerImport(program, ctx);
  registerResolve(program, ctx);
  registerBuild(program, ctx);
  registerRun(program, ctx);
  registerStatus(program, ctx);
  registerReset(program, ctx);
  registerDiscard(program, ctx);
  registerExport(program, ctx);
  registerExportAll(program, ctx);
  registerReExport(program, ctx);
  registerRebase(program, ctx);
  registerPackage(program, ctx);
  registerWatch(program, ctx);
  registerTest(program, ctx);
  registerConfig(program, ctx);
  registerDoctor(program, ctx);
  registerRegister(program, ctx);
  registerWire(program, ctx);
  registerToken(program, ctx);
  registerLint(program, ctx);
  registerFurnace(program, ctx);

  return program;
}

/**
 * Main CLI entry point.
 */
export async function main(): Promise<void> {
  const program = createProgram();
  await program.parseAsync(process.argv);
}
