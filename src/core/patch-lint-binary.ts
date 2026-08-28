// SPDX-License-Identifier: EUPL-1.2
/**
 * Queue-wide lint for binary patch bodies that cannot recreate their file.
 *
 * `git diff` has two ways to render a binary change. `git diff --binary`
 * emits a `GIT binary patch` section carrying the literal/delta payload —
 * that body can be replayed by `git apply`. Plain `git diff` emits only the
 * informational `Binary files a/x and b/x differ`, which records THAT the
 * bytes changed and carries none of them.
 *
 * The stub form is dangerous rather than merely lossy because it still
 * carries a correct `index <old>..<new>` line. Every identity-shaped check in
 * the codebase — worktree classification, foreign-drift detection — keys on
 * that hash, matches it against the live file, and concludes the patch is
 * backed. So a queue can hold a patch that provably cannot rebuild its own
 * file while every gate reports green, and the loss surfaces only at the next
 * clean-room apply. This rule is the one check that reads the body itself and
 * fails closed, whichever command wrote it.
 *
 * Body-only by design: it needs no engine checkout, so it runs anywhere the
 * queue context is available and never pulls an engine dependency into the
 * cross-patch lint graph.
 */
import type { PatchLintIssue } from '../types/commands/index.js';
import { parseDiffSections } from './patch-parse.js';

/**
 * The slice of a queue entry this rule reads. Declared structurally rather
 * than importing `PatchQueueEntry` from `patch-lint-cross.ts`, which imports
 * this module back — the local shape keeps the dependency edge one-way and
 * `dpdm` clean, matching `patch-lint-module-registration.ts`.
 */
interface BinaryBodyQueueEntry {
  filename: string;
  diff: string;
}

/** Queue view accepted by {@link lintPatchQueueBinaryBodies}. */
interface BinaryBodyQueueContext {
  entries: readonly BinaryBodyQueueEntry[];
}

/** Lint check identifier emitted by {@link lintPatchQueueBinaryBodies}. */
export const BINARY_BODY_CHECK = 'binary-body-not-reconstructable';

/**
 * Flags every binary diff section whose body carries no reconstructable
 * payload.
 *
 * Deletions are exempt: a `deleted file mode` section needs no bytes to
 * replay, so the informational form is complete for that case.
 *
 * @param ctx - Queue context (raw patch bodies in application order)
 * @returns One error-severity issue per offending file per patch
 */
export function lintPatchQueueBinaryBodies(ctx: BinaryBodyQueueContext): PatchLintIssue[] {
  const issues: PatchLintIssue[] = [];
  for (const entry of ctx.entries) {
    const seen = new Set<string>();
    for (const section of parseDiffSections(entry.diff)) {
      if (!section.isBinary || section.hasBinaryDelta || section.isDeletedFile) continue;
      const file = section.targetPath;
      if (seen.has(file)) continue;
      seen.add(file);
      issues.push({
        file,
        check: BINARY_BODY_CHECK,
        patches: [entry.filename],
        fingerprint: `${BINARY_BODY_CHECK}|${entry.filename}|${file}`,
        message:
          `Binary file "${file}" is recorded in ${entry.filename} as "Binary files … differ", ` +
          'which carries no data and cannot recreate the file on apply. ' +
          `Re-export the patch from a tree where ${file} is present ` +
          `("fireforge re-export ${entry.filename}") so the body carries a GIT binary patch delta.`,
        severity: 'error',
      });
    }
  }
  return issues;
}
