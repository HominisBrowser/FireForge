// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared engine precondition ladder for commands that read or mutate
 * `engine/` through git.
 *
 * Five commands carried their own copy of this three-rung check, and **two of
 * them were truncated**: `resolve.ts` and `token-coverage.ts` stopped after
 * the `isGitRepository` rung and omitted the unborn-HEAD guard entirely
 * (neither even imported `getHead`/`isMissingHeadError`). Both then went on to
 * enumerate working-tree status, and against an unborn HEAD the whole
 * ~300k-file Firefox tree reads as untracked — so an engine left half
 * initialised by an interrupted `download` produced a nonsensical result
 * rather than the actionable refusal the other three commands gave.
 *
 * The remediation paragraph also existed in three independently-editable
 * copies that had already drifted. It lives here once now.
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
   * Preserves the one deliberate wording divergence between the copies. The
   * base message deliberately ends WITHOUT punctuation so the suffix reads as
   * one sentence; callers that pass nothing get a plain full stop.
   */
  unbornHeadSuffix?: string;
}

/**
 * Asserts that `engineDir` exists, is a git repository, and has a baseline
 * commit — in that order, so the operator gets the most specific applicable
 * remediation rather than a downstream git error.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @param options - Optional per-command message tailoring
 */
export async function assertEngineGitReady(
  engineDir: string,
  options: EngineGitReadyOptions = {}
): Promise<void> {
  if (!(await pathExists(engineDir))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

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
