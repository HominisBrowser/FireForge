// SPDX-License-Identifier: EUPL-1.2
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { LintCommandOptions } from '../types/commands/index.js';

/** Refuse contradictory or invalid lint scopes before collecting source. */
export function validateLintFlags(options: LintCommandOptions): void {
  // `--only-introduced` scopes the exit code to `--since`-tagged issues, so
  // without a revision to anchor the diff there is no "introduced" subset
  // to scope to. Reject the combination up-front so a misconfigured CI
  // invocation fails loud instead of silently treating every error as
  // cumulative and passing.
  if (options.onlyIntroduced && !options.since) {
    throw new GeneralError(
      '--only-introduced requires --since <git-rev> so introduced-vs-cumulative can be distinguished.'
    );
  }

  if (
    options.maxWarnings !== undefined &&
    (!Number.isInteger(options.maxWarnings) || options.maxWarnings < 0)
  ) {
    throw new InvalidArgumentError(
      '--max-warnings must be a non-negative integer.',
      '--max-warnings'
    );
  }

  // `--patches` only means something in per-patch mode, where it filters
  // the queue. In aggregate/file-list mode there is no patch loop to narrow.
  if (options.patches !== undefined && !options.perPatch) {
    throw new InvalidArgumentError('--patches requires --per-patch.', '--patches');
  }

  // The JSON report is a per-patch artifact (per-patch size metrics and
  // suppressed issues). Aggregate mode has no per-patch rows to report.
  if (options.report !== undefined && !options.perPatch) {
    throw new InvalidArgumentError('--report requires --per-patch.', '--report');
  }

  if (options.notices !== undefined && !options.perPatch) {
    throw new InvalidArgumentError('--notices requires --per-patch.', '--notices');
  }
}
