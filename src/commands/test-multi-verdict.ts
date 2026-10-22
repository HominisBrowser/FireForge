// SPDX-License-Identifier: EUPL-1.2
/**
 * Per-run lines and the aggregate verdict of a multi-run `fireforge test`
 * (`--repeat`, mixed harnesses, `--negative-control`). Pure: the
 * orchestration in `test-orchestrate.ts` feeds it the verdict line each
 * sub-run would have printed, captured instead of written.
 */

/** The prefix every verdict line starts with. */
const VERDICT_PREFIX = 'FIREFORGE-VERDICT: ';

/** One finished sub-run. */
export interface SubRunResult {
  /** 1-based repetition this run belongs to. */
  repetition: number;
  /** The harness half of a mixed invocation. */
  harness?: 'xpcshell' | 'mochitest';
  /** The captured verdict, without the `FIREFORGE-VERDICT: ` prefix. */
  body: string;
  passed: boolean;
  /** `reason=` of a failed run. */
  reason?: string;
  /** `note=` of a failed run, when it carried one. */
  note?: string;
  /** What the sub-run threw, if anything. */
  error?: unknown;
}

/**
 * How a negative control came out: `caught` when every repetition went red
 * on test failures, `missed` when a repetition stayed green (the tests did
 * not detect the mutation), `inconclusive` when any run failed for another
 * reason or the invocation stopped early.
 */
export type ControlOutcome = 'caught' | 'missed' | 'inconclusive';

/**
 * Parses a captured verdict line into a sub-run result.
 *
 * @param line - The captured line, or undefined when the sub-run wrote none
 */
export function parseCapturedVerdict(
  line: string | undefined
): Pick<SubRunResult, 'body' | 'passed' | 'reason' | 'note'> {
  const body = (line ?? `${VERDICT_PREFIX}FAIL reason=preflight`).slice(VERDICT_PREFIX.length);
  const passed = body.startsWith('PASS');
  const reason = /(?:^| )reason=(\S+)/.exec(body)?.[1];
  const note = /(?:^| )note=(\S+)/.exec(body)?.[1];
  return {
    body,
    passed,
    ...(reason === undefined ? {} : { reason }),
    ...(note === undefined ? {} : { note }),
  };
}

/**
 * The `FIREFORGE-RUN:` line for one sub-run: the verdict it would have
 * printed alone, plus `run=<i>/<n>` and, for a mixed invocation,
 * `harness=`. Never `FIREFORGE-VERDICT:`, so the invocation keeps exactly
 * one verdict line.
 */
export function formatRunLine(result: SubRunResult, index: number, total: number): string {
  const harness = result.harness === undefined ? '' : ` harness=${result.harness}`;
  return `FIREFORGE-RUN: ${result.body} run=${index + 1}/${total}${harness}`;
}

/** Most structural first: the reason an aggregate failure reports. */
const REASON_RANK = [
  'inconclusive',
  'preflight',
  'crash',
  'server-startup',
  'harness-arguments',
  'no-tests',
  'test-failures',
];

function rankOf(reason: string | undefined): number {
  const rank = REASON_RANK.indexOf(reason ?? '');
  return rank === -1 ? REASON_RANK.length : rank;
}

/** The failed run with the most structural reason, or undefined when all passed. */
export function worstRun(results: readonly SubRunResult[]): SubRunResult | undefined {
  let worst: SubRunResult | undefined;
  for (const result of results) {
    if (result.passed) continue;
    if (worst === undefined || rankOf(result.reason) < rankOf(worst.reason)) worst = result;
  }
  return worst;
}

/**
 * Derives a negative control's outcome.
 *
 * @param results - Every finished sub-run
 * @param repetitions - How many repetitions were planned
 * @param complete - False when the invocation stopped before its last run
 */
export function deriveControlOutcome(
  results: readonly SubRunResult[],
  repetitions: number,
  complete: boolean
): ControlOutcome {
  if (!complete) return 'inconclusive';
  if (results.some((result) => !result.passed && result.reason !== 'test-failures')) {
    return 'inconclusive';
  }
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    const red = results.some(
      (result) => result.repetition === repetition && result.reason === 'test-failures'
    );
    if (!red) return 'missed';
  }
  return 'caught';
}

/**
 * The aggregate verdict body. A single planned run (a lone control) keeps
 * its own line, counts included; several aggregate to `PASS runs=<n>/<n>`
 * or `FAIL reason=<most structural> [note=] runs=<passed>/<planned>`.
 * A control appends `control=<outcome>`.
 */
export function formatAggregateBody(
  results: readonly SubRunResult[],
  plannedTotal: number,
  control?: ControlOutcome
): string {
  const controlKey = control === undefined ? '' : ` control=${control}`;
  const only = results[0];
  if (plannedTotal === 1 && only !== undefined) return `${only.body}${controlKey}`;
  const passed = results.filter((result) => result.passed).length;
  const runs = ` runs=${passed}/${plannedTotal}`;
  const worst = worstRun(results);
  if (worst === undefined && results.length === plannedTotal) return `PASS${runs}${controlKey}`;
  const reason = worst?.reason ?? 'preflight';
  const note = worst?.note === undefined ? '' : ` note=${worst.note}`;
  return `FAIL reason=${reason}${note}${runs}${controlKey}`;
}

/** One-line human summary of a control's outcome. */
export function describeControlOutcome(outcome: ControlOutcome): string {
  switch (outcome) {
    case 'caught':
      return 'Negative control: the tests went red on the mutation, as a control should (control=caught).';
    case 'missed':
      return 'Negative control: the tests STAYED GREEN with the mutation applied, so they do not detect it (control=missed).';
    case 'inconclusive':
      return 'Negative control: inconclusive, a run failed for a reason other than test failures or did not run (control=inconclusive).';
  }
}
