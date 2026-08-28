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

import type { PatchLintIssue } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { isMissingHeadError } from './git.js';
import { git } from './git-base.js';
import { getUntrackedFiles } from './git-status.js';

/**
 * Collects engine-relative paths that changed between `rev` and `HEAD`,
 * plus any workdir modifications and untracked files. An empty set means
 * "no diff we can prove" — downstream treats every issue as `cumulative`
 * in that case (operator ran `lint --since HEAD` with no pending work).
 * @param engineDir Path to the engine git repository.
 * @param rev Git revision to diff against (e.g. `HEAD`, a branch, a SHA).
 */
export async function collectDiffFilePaths(engineDir: string, rev: string): Promise<Set<string>> {
  const files = new Set<string>();

  try {
    const commitDiff = await git(['diff', '--name-only', `${rev}...HEAD`], engineDir);
    for (const line of commitDiff.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch (error: unknown) {
    if (!isMissingHeadError(error)) {
      verbose(`lint --since: could not diff against ${rev} — ${toError(error).message}`);
    }
  }

  try {
    const worktreeDiff = await git(['diff', '--name-only', 'HEAD'], engineDir);
    for (const line of worktreeDiff.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }
  } catch (error: unknown) {
    verbose(`lint --since: could not enumerate workdir diff — ${toError(error).message}`);
  }

  try {
    for (const file of await getUntrackedFiles(engineDir)) {
      files.add(file);
    }
  } catch (error: unknown) {
    verbose(`lint --since: could not list untracked files — ${toError(error).message}`);
  }

  return files;
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
 * Mutates each issue in place AND returns the list for chaining.
 *
 * Issues with no file (`issue.file === ''`) — e.g. cross-patch rules that
 * describe queue-wide state — are always `cumulative` under `--since`
 * because they describe drift accumulated across many commits, not a single
 * current-task edit.
 *
 * Aggregate patch-size rules emit `issue.file === AGGREGATE_PATCH_FILE`, a
 * synthetic placeholder that can never appear in a real `diffFiles` set.
 * Without special-casing, `large-patch-files` / `large-patch-lines` are
 * always tagged `[cumulative]` under `--only-introduced` even when the diff
 * IS the aggregate the rules measured, which reads as "this pre-existed" to
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
