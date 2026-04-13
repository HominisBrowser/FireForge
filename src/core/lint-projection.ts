// SPDX-License-Identifier: EUPL-1.2
import type { PatchLintIssue } from '../types/commands/index.js';

/**
 * Diffs projected lint issues against the baseline and returns those
 * considered "new" regressions.
 *
 * The equality key is the issue fingerprint when present, otherwise the
 * full `(check, file, message)` triple. Fingerprints are emitted by rules
 * whose message text can drift between otherwise-equivalent runs (for
 * example because the message embeds later-owner filenames or positional
 * detail). Falling back to the full tuple keeps the helper conservative
 * for older/non-fingerprinted rules: if their message changes, we would
 * rather surface a potential regression than silently swallow it.
 *
 * Consumption order within the projected list is stable (the input
 * order is preserved), so when baseline has N issues for a key and
 * projected has N+M for the same key, the *last* M projected issues on
 * that key are reported as regressions. That keeps the reporting
 * deterministic and gives the operator at least one concrete message
 * per regression even when only counts differ.
 *
 * @param baseline - Error-severity issues from the current queue
 * @param projected - Error-severity issues from the projected queue
 * @returns Subset of `projected` not matched by a baseline counterpart
 */
export function computeProjectedLintRegressions(
  baseline: PatchLintIssue[],
  projected: PatchLintIssue[]
): PatchLintIssue[] {
  const issueKey = (i: PatchLintIssue): string =>
    i.fingerprint ?? `${i.check}|${i.file}|${i.message}`;

  const baselineCounts = new Map<string, number>();
  for (const issue of baseline) {
    const key = issueKey(issue);
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }

  const regressions: PatchLintIssue[] = [];
  const consumedByKey = new Map<string, number>();
  for (const issue of projected) {
    const key = issueKey(issue);
    const allowed = baselineCounts.get(key) ?? 0;
    const consumed = consumedByKey.get(key) ?? 0;
    if (consumed >= allowed) {
      regressions.push(issue);
    }
    consumedByKey.set(key, consumed + 1);
  }

  return regressions;
}
