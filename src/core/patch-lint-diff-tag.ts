// SPDX-License-Identifier: EUPL-1.2
/**
 * Diff-scoping for `fireforge lint`.
 *
 * Pre-existing patch-state errors and errors introduced by the current task
 * print identically, so triaging "is the diff I just produced clean?"
 * otherwise means mentally subtracting the pre-existing noise. This module
 * classifies each lint issue as either `introduced` (the file was touched
 * since the user-supplied git revision) or `cumulative` (pre-existing
 * drift), without changing what the underlying rules emit.
 */

import { InvalidArgumentError } from '../errors/base.js';
import { GitError } from '../errors/git.js';
import type { PatchLintIssue } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { git } from './git-base.js';

/**
 * Resolves `--since` to a commit in the engine repository. A revision git
 * cannot resolve is a usage error: tagging against it would measure nothing,
 * and an empty measurement would call every issue cumulative.
 * @param engineDir Path to the engine git repository.
 * @param rev Git revision as the operator typed it.
 */
export async function resolveSinceRevision(engineDir: string, rev: string): Promise<string> {
  try {
    const resolved = await git(
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${rev}^{commit}`],
      engineDir
    );
    const commit = resolved.trim();
    if (commit) return commit;
  } catch {
    // Reported below: `--verify --quiet` fails without a message.
  }
  throw new InvalidArgumentError(
    `--since ${JSON.stringify(rev)} does not name a commit in engine/. Pass a branch, tag or SHA that exists there (e.g. HEAD).`,
    '--since'
  );
}

/** NUL-separated path output, as `-z` prints it. */
function pathList(output: string): string[] {
  return output.split('\0').filter((path) => path.length > 0);
}

/**
 * Collects engine-relative paths that changed between `rev` and `HEAD`,
 * plus any workdir modifications and untracked files. An empty set is a
 * measured empty diff (`lint --since HEAD` with no pending work), never a
 * failed one: a revision that does not resolve is an
 * {@link InvalidArgumentError}, and a git failure while measuring is a
 * {@link GitError}, because a missing diff would tag every issue cumulative
 * and let `--only-introduced` pass new errors.
 * @param engineDir Path to the engine git repository.
 * @param rev Git revision to diff against (e.g. `HEAD`, a branch, a SHA).
 */
export async function collectDiffFilePaths(engineDir: string, rev: string): Promise<Set<string>> {
  const since = await resolveSinceRevision(engineDir, rev);
  const measure = async (what: string, args: string[]): Promise<string[]> => {
    try {
      return pathList(await git(args, engineDir));
    } catch (error: unknown) {
      throw new GitError(
        `lint --since ${rev}: could not list ${what}, so introduced and cumulative issues cannot be told apart: ${toError(error).message}`,
        args.join(' ')
      );
    }
  };
  return new Set([
    ...(await measure('the files changed since it', [
      'diff',
      '--name-only',
      '-z',
      `${since}...HEAD`,
    ])),
    ...(await measure('working-tree changes', ['diff', '--name-only', '-z', 'HEAD'])),
    ...(await measure('untracked files', ['ls-files', '--others', '--exclude-standard', '-z'])),
  ]);
}

/**
 * Synthetic "file" value used by aggregate patch-size rules
 * (`large-patch-files` / `large-patch-lines`) to flag that a finding
 * describes the whole diff rather than a single path. Exported so callers
 * can keep the tagging contract visible in one place.
 */
export const AGGREGATE_PATCH_FILE = '(patch)';

/**
 * Annotates a list of lint issues with `introduced` / `cumulative` tags
 * based on whether the issue's file is part of the supplied diff set.
 * Mutates each issue in place and returns the list for chaining.
 *
 * Issues with no file (`issue.file === ''`), for example cross-patch rules
 * that describe queue-wide state, are always `cumulative` under `--since`
 * because they describe drift accumulated across many commits, not a single
 * current-task edit.
 *
 * Aggregate patch-size rules emit `issue.file === AGGREGATE_PATCH_FILE`, a
 * synthetic placeholder that can never appear in a real `diffFiles` set.
 * Without special-casing, `large-patch-files` / `large-patch-lines` are
 * always tagged `[cumulative]` under `--only-introduced` even when the diff
 * is the aggregate the rules measured, which reads as "this pre-existed" to
 * an operator asking "what did this diff introduce?". The aggregate tag is
 * therefore promoted to `introduced` whenever the diff set has any content:
 * a non-empty `diffFiles` means the operator asked about a specific diff
 * scope, and the aggregate finding describes exactly that scope.
 *
 * @param issues Issues returned by the lint orchestrator.
 * @param diffFiles File paths touched since the user's revision.
 */
export function tagLintIssues(issues: PatchLintIssue[], diffFiles: Set<string>): PatchLintIssue[] {
  const hasDiffContent = diffFiles.size > 0;
  for (const issue of issues) {
    if (!issue.file) {
      issue.tag = 'cumulative';
      continue;
    }
    if (issue.file === AGGREGATE_PATCH_FILE) {
      issue.tag = hasDiffContent ? 'introduced' : 'cumulative';
      continue;
    }
    issue.tag = diffFiles.has(issue.file) ? 'introduced' : 'cumulative';
  }
  return issues;
}
