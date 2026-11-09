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

import { dirname, join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText } from '../utils/fs.js';
import { getHead, isGitRepository, isMissingHeadError } from './git.js';

/** Remediation for an engine whose baseline commit was never created. */
const UNBORN_HEAD_REMEDIATION =
  'Engine repository has no baseline commit yet — a previous "fireforge download" was ' +
  'interrupted before git created the initial Firefox source commit. ' +
  // No terminating period: the suffix below supplies its own punctuation, and
  // hardcoding one here rendered as "…cleanly., then retry the rebase."
  'Re-run "fireforge download --force" to recreate the baseline repository cleanly';

/** Whether the project that owns this engine path is in source mode. */
export async function isSourceModeEngine(engineDir: string): Promise<boolean> {
  try {
    const config = JSON.parse(await readText(join(dirname(engineDir), 'fireforge.json'))) as {
      sources?: unknown;
    };
    return config.sources !== undefined;
  } catch {
    // No readable config: the ordinary first-run remedy applies.
    return false;
  }
}

/** What a source-mode checkout without `engine/` says: what reads one runs in a job. */
export const SOURCE_MODE_NO_ENGINE_MESSAGE =
  'This source-mode checkout has no engine/. Run this inside a job, for example "fireforge job run --check", which gives it a slot.';

/**
 * What to do about a missing `engine/`. A source-mode checkout keeps none on
 * purpose, and `download` is refused there: what reads one runs in a job.
 *
 * @param engineDir - Absolute path to the engine checkout
 */
export async function missingEngineMessage(engineDir: string): Promise<string> {
  return (await isSourceModeEngine(engineDir))
    ? SOURCE_MODE_NO_ENGINE_MESSAGE
    : 'Firefox source not found. Run "fireforge download" first.';
}

/**
 * Refuses a command that judges what has been applied to `engine/` when it runs
 * in a source-mode editing checkout. There `engine/` is at most the pristine
 * donor: nothing is deployed to it, so the answer would be wrong rather than
 * merely empty. Inside a job the executor names the step in
 * `FIREFORGE_ADAPTER_COMMAND`, which only ever allows the command, never grants it.
 *
 * @param projectRoot - Project root directory
 * @param command - The command, as the person typed it
 * @param alternative - What to run instead
 */
export async function assertJudgedInSlot(
  projectRoot: string,
  command: string,
  alternative = 'fireforge job run --check'
): Promise<void> {
  if (process.env['FIREFORGE_ADAPTER_COMMAND'] !== undefined) return;
  if (!(await isSourceModeEngine(join(projectRoot, 'engine')))) return;
  throw new GeneralError(
    `${command} judges what has been deployed to engine/, and in a source-mode editing checkout engine/ is only the pristine donor, so its answer would be wrong. Run "${alternative}", which gives it a slot.`
  );
}

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
    throw new GeneralError(await missingEngineMessage(engineDir));
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
