// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { ensureOriginRemote } from '../core/git.js';
import { bootstrapWithOutput } from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { BootstrapError } from '../errors/build.js';
import type { CommandContext } from '../types/cli.js';
import { pathExists } from '../utils/fs.js';
import { error, info, intro, outro } from '../utils/logger.js';

function buildBootstrapFailureMessage(output: string): string | undefined {
  const normalized = output.replace(/\r\n/g, '\n');
  const issues: string[] = [];

  if (/traceback \(most recent call last\):/i.test(normalized)) {
    issues.push('Bootstrap emitted a Python traceback.');
  }

  if (/\bhttp(?:\s+error)?\s*403\b/i.test(normalized) || /\b403\b.*forbidden/i.test(normalized)) {
    issues.push('Bootstrap hit an HTTP 403 while fetching dependencies.');
  }

  if (
    /no such remote ['"]origin['"]/i.test(normalized) ||
    /remote ['"]origin['"] does not exist/i.test(normalized) ||
    /missing git remote ['"]origin['"]/i.test(normalized)
  ) {
    issues.push('Bootstrap expected an "origin" git remote in the Firefox source checkout.');
  }

  if (issues.length === 0) {
    return undefined;
  }

  return (
    'Bootstrap did not complete successfully.\n\n' +
    `${issues.join('\n')}\n\n` +
    'Review the bootstrap output above, fix the underlying dependency or source-tree issue, and rerun "fireforge bootstrap".'
  );
}

/**
 * Runs the bootstrap command.
 * @param projectRoot - Root directory of the project
 */
export async function bootstrapCommand(projectRoot: string): Promise<void> {
  intro('FireForge Bootstrap');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Ensure the engine repo has an "origin" remote so Firefox's bootstrap
  // scripts don't emit noisy "No such remote" errors.
  await ensureOriginRemote(paths.engine);

  info('Installing Firefox build dependencies...');
  info('This may take a while and require sudo permissions.\n');

  const result = await bootstrapWithOutput(paths.engine);

  if (result.exitCode !== 0) {
    error('Bootstrap failed');
    const failureMessage = buildBootstrapFailureMessage(`${result.stdout}\n${result.stderr}`);
    if (failureMessage) {
      throw new GeneralError(failureMessage);
    }
    throw new BootstrapError();
  }

  // mach bootstrap may exit 0 even when sub-downloads fail (e.g. HTTP 403).
  // Scan output for known failure patterns and surface them as warnings.
  const softFailure = buildBootstrapFailureMessage(`${result.stdout}\n${result.stderr}`);
  if (softFailure) {
    info('');
    info(softFailure);
    info('Bootstrap exited successfully but the issues above may cause build failures.');
  }

  outro('Build dependencies installed successfully!');
}

/** Registers the bootstrap command on the CLI program. */
export function registerBootstrap(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('bootstrap')
    .description('Install Firefox build dependencies')
    .action(
      withErrorHandling(async () => {
        await bootstrapCommand(getProjectRoot());
      })
    );
}
