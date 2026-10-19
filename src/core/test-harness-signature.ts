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
}

/**
 * The verdict line's `started=<n>/<m> first-unstarted=<path>
 * [started-source=<src>]` keys, or nothing when every file started.
 */
export function formatIncompleteSuffix(evidence: IncompleteRunEvidence | undefined): string {
  if (evidence?.firstUnstarted === undefined) return '';
  const source =
    evidence.startedSource === undefined ? '' : ` started-source=${evidence.startedSource}`;
  return ` started=${evidence.started}/${evidence.requested} first-unstarted=${evidence.firstUnstarted}${source}`;
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
  /** The summary's non-zero `Unexpected results:` count, when it printed one. */
  unexpected?: number;
}
