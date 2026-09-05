// SPDX-License-Identifier: EUPL-1.2
/**
 * Verdict-note helpers for the harness classifier.
 *
 * Split out of `test-harness-crash.ts` (at its per-file line budget). These
 * decide the advisory parenthetical on the `FIREFORGE-VERDICT:` line. None
 * of them changes a status or a reason key, which the verdict contract's
 * consumers parse.
 */

/**
 * The only part of the classifier's summary counts these notes read.
 * Structural rather than an import of `HarnessSummaryCounts`: a type edge
 * back into `test-harness-crash.ts` is still an edge, and the cycle gate
 * rejects it.
 */
interface SummaryCountsView {
  unexpected?: number;
}

/**
 * A single `TEST-UNEXPECTED-*` marker. Local copy of the classifier's line
 * pattern: importing the value would draw a runtime edge back into
 * `test-harness-crash.ts` and make the split circular.
 */
const UNEXPECTED_MARKER = /TEST-UNEXPECTED-\w+/;

/**
 * Belt for the residual case the tightened {@link FAIL_LINE_PATTERN} /
 * {@link ASSERTION_LINE_PATTERN} cannot reach: the summary reported
 * `Unexpected results: 0`, yet the run is still classified `test-failures`
 * on evidence lines that carry NO `TEST-UNEXPECTED-*` marker.
 *
 * `unexpected=0` printed beside `reason=test-failures` means the verdict
 * rests on pattern matching rather than on a harness result, and a
 * reader who cannot see that spends hours attributing a red run to the
 * change under test. The note says so on the verdict line itself.
 *
 * This is a note and not a reclassification: a non-zero exit with no
 * green-shaped summary is still a failing run, and inventing a new `reason`
 * would break the `FIREFORGE-VERDICT:` contract its consumers parse.
 */
export function unmarkedFailureEvidenceNote(
  counts: SummaryCountsView,
  realFailures: readonly string[]
): string | undefined {
  if (counts.unexpected !== 0) return undefined;
  if (realFailures.length === 0) return undefined;
  if (realFailures.some((line) => UNEXPECTED_MARKER.test(line))) return undefined;
  return 'summary reported 0 unexpected; no TEST-UNEXPECTED marker in the matched evidence';
}

/** Caps an evidence line so the one-line verdict note stays one line. */
export function truncateEvidence(line: string): string {
  const flat = line.trim().replace(/\s+/g, ' ');
  return flat.length <= GREEN_TEARDOWN_EVIDENCE_LIMIT
    ? flat
    : `${flat.slice(0, GREEN_TEARDOWN_EVIDENCE_LIMIT)}…`;
}

/** Character budget for an evidence excerpt inside the verdict note. */
const GREEN_TEARDOWN_EVIDENCE_LIMIT = 80;

/**
 * Outcome of the green-teardown belt.
 *
 * `accepted` is the pass. A rejection carries `rejectedBy` only when the
 * recognized teardown noise was present, i.e. when the belt was the thing
 * that could have applied and did not. That is what the field is for: a run
 * with no teardown traceback was never a candidate and naming a "rejecting
 * condition" for it would be noise, whereas a run that does carry the
 * traceback and still fails is the shape an operator otherwise cannot
 * diagnose from outside. Every condition is all-or-nothing, so the failing
 * verdict looks identical whichever one rejected it, and a downstream report
 * spent a re-run and a filed-bug's worth of effort guessing between them.
 */
export interface GreenTeardownOverride {
  accepted: boolean;
  /** Which single condition rejected, when the teardown noise was present. */
  rejectedBy?: string;
}
