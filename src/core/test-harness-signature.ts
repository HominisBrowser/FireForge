// SPDX-License-Identifier: EUPL-1.2
/**
 * The recognized-harness-crash shape, in a module of its own.
 *
 * It lives apart from both of its users to break an import cycle:
 * `test-harness-crash.ts` re-exports the operator advice in
 * `test-stall-triage.ts`, and the triage text is keyed on this signature. A
 * type-only edge is erased at runtime, but the cycle gate reads the import
 * graph rather than the emitted code, and a shared leaf is a truer
 * description of the relationship than either direction of the cycle was:
 * neither module owns this type more than the other.
 *
 * {@link IncompleteRunEvidence} lives here for the same reason:
 * `test-run-completeness.ts` produces it from helpers in
 * `test-harness-crash.ts`, whose verdict type carries it.
 */

/** A recognized harness-crash shape with its evidence line. */
export interface HarnessCrashSignature {
  /** Stable reason id for the recognized shape. */
  reason: string;
  /** The concrete output line the recognition was based on. */
  line: string;
  /**
   * The verdict line's `reason=` for an infrastructure shape that is not a
   * crash of the harness: `server-startup` when a mochitest server never
   * came up. Unset: `reason=crash`.
   */
  verdictReason?: 'server-startup';
  /**
   * The harness's own port and browser-wait lines printed before a startup
   * timeout, so the operator can see which ports the run held when it hung.
   */
  harnessLines?: string[];
}

/** Start and skip marker names seen in a run's output. */
export interface StartMarkers {
  started: string[];
  skipped: string[];
}

/** The two facts the classifier needs from a dispatch's raw log. */
export interface RawRunSummary {
  /** How many tests have a `test_end` record. */
  testsEnded: number;
  /** A `suite_end` closed every `suite_start`. */
  suiteCompleted: boolean;
}

/**
 * The verdict line's `started=<n>/<m> first-unstarted=<path>
 * [started-source=<src>]`, `unfinished=<n>` and `app-exit=<signal>` keys, or
 * nothing when none applies.
 */
export function formatIncompleteSuffix(evidence: IncompleteRunEvidence | undefined): string {
  const unfinished =
    evidence?.unfinished === undefined ? '' : ` unfinished=${evidence.unfinished.length}`;
  const exit = `${unfinished}${evidence?.appExit === undefined ? '' : ` app-exit=${evidence.appExit}`}`;
  if (evidence?.firstUnstarted === undefined) return exit;
  const source =
    evidence.startedSource === undefined ? '' : ` started-source=${evidence.startedSource}`;
  return ` started=${evidence.started}/${evidence.requested} first-unstarted=${evidence.firstUnstarted}${source}${exit}`;
}

/** The verdict line's `shards=<p>/<t> [failed-shards=<labels>]` keys of a sharded run. */
export function formatShardsSuffix(
  shards: { passed: number; total: number; failed?: readonly string[] } | undefined
): string {
  if (shards === undefined) return '';
  const failed =
    shards.failed !== undefined && shards.failed.length > 0
      ? ` failed-shards=${shards.failed.join(',')}`
      : '';
  return ` shards=${shards.passed}/${shards.total}${failed}`;
}

/** Why an exit-0 run that would have read as a pass was failed instead. */
export interface IncompleteRunEvidence {
  /** Requested test files that produced a start (or skip) marker. */
  started: number;
  /** Requested test files the run could account for (test-file-shaped paths). */
  requested: number;
  /** First requested file, in dispatch order, that never started. */
  firstUnstarted?: string;
  /**
   * Which evidence the start count came from, stamped with a short count:
   * the structured raw log, the streamed output, or the capped capture.
   */
  startedSource?: 'raw' | 'stream' | 'capture';
  /** The harness's "shut down in the middle of a test" line, when present. */
  shutdownLine?: string;
  /** The non-zero unexpected count, from the raw log when the run wrote one. */
  unexpected?: number;
  /** Tests the raw log started and never ended. */
  unfinished?: string[];
  /** Browser termination signal explicitly reported by the harness. */
  appExit?: string;
}

/** Why a green-looking embedded summary was not trusted. */
export interface GreenSummaryRejection {
  /** Crash-marker evidence line (mozcrash / signal kill), if any. */
  crashLine?: string;
  /** Why the non-zero exit cannot be blamed on harness noise, if it cannot. */
  exitEvidence?: string;
  /** Requested test files with no `TEST_START`/`TEST-START` line at all. */
  neverStarted: string[];
  /** Files whose `TEST_START` has no matching end marker. */
  neverEnded: string[];
}
