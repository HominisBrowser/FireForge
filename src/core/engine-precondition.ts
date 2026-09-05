// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared engine precondition ladder for commands that read or mutate
 * `engine/` through git.
 *
 * The rungs matter in order. Skipping the unborn-HEAD guard and going
 * straight to enumerating working-tree status makes the whole ~300k-file
 * Firefox tree read as untracked, so an engine left half-initialised by an
 * interrupted `download` produces a nonsensical result instead of an
 * actionable refusal.
 *
 * The remediation wording lives here once so the callers cannot drift apart.
 */

import { GeneralError } from '../errors/base.js';
import { pathExists } from '../utils/fs.js';
import { getHead, isGitRepository, isMissingHeadError } from './git.js';

/** Remediation for an engine whose baseline commit was never created. */
const UNBORN_HEAD_REMEDIATION =
  'Engine repository has no baseline commit yet — a previous "fireforge download" was ' +
  'interrupted before git created the initial Firefox source commit. ' +
  // No terminating period: the suffix below supplies its own punctuation, and
  // hardcoding one here rendered as "…cleanly., then retry the rebase."
  'Re-run "fireforge download --force" to recreate the baseline repository cleanly';

/** Options for {@link assertEngineGitReady}. */
export interface EngineGitReadyOptions {
  /**
   * Appended to the unborn-HEAD remediation, e.g. `', then retry the rebase.'`
   * The base message ends without punctuation on purpose so the suffix
   * reads as one sentence. Callers that pass nothing get a plain full stop.
   */
  unbornHeadSuffix?: string;
}

/**
 * Asserts only that the engine checkout exists.
 *
 * The first rung of {@link assertEngineGitReady}. Most callers want exactly
 * this rung and no more: `build`, `run`, `test`, `package`, `watch`,
 * `import` and `bootstrap` never run git against the engine and each has its
 * own richer follow-up gate, so promoting them to the full three-rung ladder
 * would refuse runs that work today.
 *
 * @param engineDir - Absolute path to the engine checkout
 */
export async function assertEngineExists(engineDir: string): Promise<void> {
  if (!(await pathExists(engineDir))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }
}

/**
 * Asserts that `engineDir` exists, is a git repository, and has a baseline
 * commit, in that order, so the operator gets the most specific applicable
 * remediation rather than a downstream git error.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @param options - Optional per-command message tailoring
 */
export async function assertEngineGitReady(
  engineDir: string,
  options: EngineGitReadyOptions = {}
): Promise<void> {
  await assertEngineExists(engineDir);

  if (!(await isGitRepository(engineDir))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  try {
    await getHead(engineDir);
  } catch (headError: unknown) {
    if (!isMissingHeadError(headError)) throw headError;
    throw new GeneralError(`${UNBORN_HEAD_REMEDIATION}${options.unbornHeadSuffix ?? '.'}`);
  }
}
