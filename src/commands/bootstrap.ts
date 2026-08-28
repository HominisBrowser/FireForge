// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import { getProjectPaths } from '../core/config.js';
import { assertEngineExists } from '../core/engine-precondition.js';
import { ensureOriginRemote } from '../core/git.js';
import { bootstrapWithOutput } from '../core/mach.js';
import { GeneralError } from '../errors/base.js';
import { BootstrapError } from '../errors/build.js';
import { ExitCode } from '../errors/codes.js';
import type { CommandContext } from '../types/cli.js';
import { error, info, intro, outro, warn } from '../utils/logger.js';
import {
  type BootstrapIssue,
  detectBootstrapIssues,
  runPostBootstrapChecks,
} from './bootstrap-checks.js';
import { reportDoctorResults } from './doctor.js';
import { resolveDoctorSeverity } from './doctor-check-core.js';

/** One sentence per detected issue, keyed by the scanner's own tags. */
const BOOTSTRAP_FAILURE_SENTENCES: Record<BootstrapIssue, string> = {
  'python-traceback': 'Bootstrap emitted a Python traceback.',
  'sdk-fetch-403': 'Bootstrap hit an HTTP 403 while fetching dependencies.',
  'missing-origin-remote':
    'Bootstrap expected an "origin" git remote in the Firefox source checkout.',
};

/**
 * Builds a human-readable failure message for hard failures (non-zero exit).
 * Used only when mach bootstrap itself reports failure.
 */
function buildBootstrapFailureMessage(output: string): string | undefined {
  // Delegates detection to the canonical scanner rather than keeping a
  // second copy of its six regexes. The copies had already disagreed: this
  // one reported a traceback AND a 403 separately, while
  // `detectBootstrapIssues` collapses them, because a bootstrap traceback
  // accompanying a 403 is just the stack trace from that HTTP error.
  const issues = detectBootstrapIssues(output).map((issue) => BOOTSTRAP_FAILURE_SENTENCES[issue]);

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
export async function bootstrapCommand(projectRoot: string): Promise<ExitCode> {
  intro('FireForge Bootstrap');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  await assertEngineExists(paths.engine);

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
  // Instead of guessing from output text, detect what went wrong and run
  // targeted checks to determine whether the issues are actually actionable.
  const output = `${result.stdout}\n${result.stderr}`;
  const issues = detectBootstrapIssues(output);

  if (issues.length > 0) {
    const checks = await runPostBootstrapChecks(issues);
    // Shares one resolver with reportDoctorResults so the two consumers of
    // this same array cannot drift apart on how a check's severity is
    // derived.
    const hasErrors = checks.some((c) => resolveDoctorSeverity(c) === 'error');

    info('');
    if (hasErrors) {
      warn('Bootstrap completed with issues:');
    } else {
      warn('Bootstrap completed with warnings:');
    }

    const checksExitCode = reportDoctorResults(checks);

    if (hasErrors) {
      outro('Build dependencies installed with errors');
      // Propagate the failure (mirroring doctor's exit-code handling)
      // instead of exiting 0 — CI gating on bootstrap used to proceed to a
      // build that could not succeed because error-severity check results
      // were discarded here.
      return checksExitCode;
    }
    outro('Build dependencies installed with warnings');
    return ExitCode.SUCCESS;
  }

  outro('Build dependencies installed successfully!');
  return ExitCode.SUCCESS;
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
        const exitCode = await bootstrapCommand(getProjectRoot());
        if (exitCode !== ExitCode.SUCCESS) {
          process.exitCode = exitCode;
        }
      })
    );
}
