// SPDX-License-Identifier: EUPL-1.2
import { wantsMachineOutput } from '../cli-usage-error.js';
import { type JobProgress, progressLine, resultsLine } from '../core/jobs/job-progress.js';
import type { JobStep, JobView } from '../core/jobs/schema.js';
import {
  attributionLines,
  type ProofRange,
  type RedAttribution,
} from '../core/proof/attribution.js';
import type { ObligationStatus, ProofDecision, ProofStatus } from '../core/proof/evidence.js';
import type { ProofPlan } from '../core/proof/types.js';
import { GeneralError } from '../errors/base.js';
import { setStdoutSealed } from '../utils/logger.js';
import { MACHINE_OUTPUT_SCHEMA_VERSION } from '../utils/machine-output.js';
import { output } from './job-support.js';

export const short = (id: string): string => id.slice(0, 12);

/** Whether an obligation is met, by running it or by a person's decision. */
export const met = (entry: Pick<ObligationStatus, 'state'>): boolean =>
  ['passed', 'accepted', 'waived'].includes(entry.state);

const verdictOf = (plan: ProofPlan, status: ProofStatus): string =>
  !status.complete
    ? 'incomplete'
    : plan.base.narrowed
      ? 'narrowed'
      : plan.sample !== undefined
        ? 'sampled'
        : status.waived.length > 0
          ? 'complete-with-waivers'
          : 'complete';

/** The reds of a report, against the commits of its range that touched what they read. */
export interface ReportAttribution {
  range: ProofRange;
  reds: RedAttribution[];
}

/** The sample a report stands on, and what it left out, at most this many named. */
const UNSAMPLED_LISTED = 20;

function sampleLines(plan: ProofPlan): string[] {
  const { sample } = plan;
  if (sample === undefined) return [];
  const listed = sample.unsampled.slice(0, UNSAMPLED_LISTED);
  const more = sample.unsampled.length - listed.length;
  return [
    `sampled ${String(sample.sampled.length)} of ${String(sample.of)} consumers (seed ${short(sample.seed)}); not run: ${listed.join(', ')}${more > 0 ? ` and ${String(more)} more (--json lists every one)` : ''}`,
  ];
}

/** A report's range and attributed reds, as machine output carries them. */
function machineAttribution(attribution: ReportAttribution | undefined): object {
  if (attribution === undefined) return {};
  const { base, head, label, main, total, onMain } = attribution.range;
  return {
    range: { base, head, label, ...(main === undefined ? {} : { main }), total, onMain },
    attribution: attribution.reds,
  };
}

/** What a report says about its reds' commits and the sample it stands on. */
const attributionReport = (
  plan: ProofPlan,
  attribution: ReportAttribution | undefined
): string[] => [
  ...(attribution === undefined ? [] : attributionLines(attribution.range, attribution.reds)),
  ...sampleLines(plan),
];

const decisionText = (decision: ProofDecision): string =>
  `${decision.kind} by ${decision.by} at ${decision.at}: ${decision.note}`;

/** Where each job still running a plan's steps stands. A job that cannot be read is left out. */
export async function liveProgress(
  obligations: readonly ObligationStatus[],
  read: (job: string) => Promise<JobView>
): Promise<Array<{ job: string; progress: JobProgress }>> {
  const live = new Set(
    obligations.flatMap((entry) =>
      entry.state === 'running' && entry.job !== undefined ? [entry.job] : []
    )
  );
  const views = await Promise.all([...live].map((job) => read(job).catch(() => undefined)));
  return views.flatMap((view) =>
    view?.progress === undefined ? [] : [{ job: view.id, progress: view.progress }]
  );
}

/** One line per obligation, then one verdict. A person's decision always reads as one. */
export function printStatus(
  plan: ProofPlan,
  status: ProofStatus,
  extra: {
    steps?: readonly JobStep[];
    notes?: readonly string[];
    attribution?: ReportAttribution;
    /** Where each job still running this plan's steps stands. */
    progress?: ReadonlyArray<{ job: string; progress: JobProgress }>;
  } = {}
): void {
  if (wantsMachineOutput()) {
    setStdoutSealed(true);
    output(
      JSON.stringify({
        schemaVersion: MACHINE_OUTPUT_SCHEMA_VERSION,
        verdict: verdictOf(plan, status),
        complete: status.complete,
        obligations: status.obligations,
        failures: status.failures,
        plan: {
          id: plan.id,
          tier: plan.tier,
          source: plan.source,
          base: plan.base,
          changed: plan.changed,
          notes: plan.notes,
          removedTests: plan.removedTests,
          sample: plan.sample,
        },
        ...machineAttribution(extra.attribution),
        ...(extra.steps === undefined ? {} : { steps: extra.steps }),
        ...(extra.notes === undefined ? {} : { notes: extra.notes }),
        ...(extra.progress === undefined || extra.progress.length === 0
          ? {}
          : { progress: extra.progress }),
      })
    );
    return;
  }
  output(
    `Proof ${plan.tier} source=${short(plan.source)} plan=${short(plan.id)} base=${short(plan.base.commit)} (${plan.base.label})`
  );
  for (const entry of status.obligations) {
    // A red obligation's newest red is the state printed on this line, not an earlier one.
    const earlierReds = entry.state === 'red' ? entry.reds - 1 : entry.reds;
    const facts = [
      ...(entry.job === undefined ? [] : [`job=${entry.job}`]),
      ...(entry.output === undefined ? [] : [`output=${entry.output}`]),
      ...(entry.carried === undefined ? [] : [`carried-from=${short(entry.carried)}`]),
      ...(earlierReds === 0 ? [] : [`earlier-reds=${String(earlierReds)}`]),
      ...(entry.detail === undefined ? [] : [entry.detail.split('\n')[0] ?? '']),
    ];
    output(`  ${entry.state.padEnd(11)} ${entry.id}${facts.length ? `  ${facts.join(' ')}` : ''}`);
    if (entry.decision !== undefined) output(`              ${decisionText(entry.decision)}`);
  }
  for (const failure of status.failures)
    output(`  job ${failure.job} failed after its steps: ${failure.reason}`);
  for (const live of extra.progress ?? []) {
    output(`  job ${live.job}: ${progressLine(live.progress)}`);
    if (live.progress.results.length > 0) output(`    so far: ${resultsLine(live.progress)}`);
  }
  for (const removed of plan.removedTests)
    output(
      `  removed test: ${removed.path}${removed.from.length > 0 ? ` (was in ${removed.from.join(', ')})` : ''}`
    );
  for (const line of attributionReport(plan, extra.attribution)) output(`  ${line}`);
  for (const note of [...plan.notes, ...(extra.notes ?? [])]) output(`  note: ${note}`);
  for (const step of extra.steps ?? [])
    output(`  would run: ${step.command} ${step.args.join(' ')}`);
  const done = status.obligations.filter(met).length;
  output(
    `Proof ${verdictOf(plan, status)}: ${String(done)} of ${String(status.obligations.length)} obligations`
  );
}

/**
 * Refuses a claim of completion the evidence does not support. A waived machine
 * obligation is the caller's own business at task tier and has to be stated at a gate.
 */
export function assertComplete(plan: ProofPlan, status: ProofStatus, allowWaived = false): void {
  if (!status.complete)
    throw new GeneralError(
      `proof-incomplete: ${status.obligations
        .filter((entry) => !met(entry))
        .map((entry) => `${entry.id} (${entry.state})`)
        .join(', ')}`
    );
  if (plan.base.narrowed)
    throw new GeneralError(
      `proof-base-narrowed: ${plan.base.label} leaves out commits of this branch, so it cannot claim completion. Run without --base.`
    );
  if (plan.tier === 'gate' && status.waived.length > 0 && !allowWaived)
    throw new GeneralError(
      `proof-waived: ${status.waived.join(', ')} ran no evidence, only a waiver. Run them, or state it with --allow-waived --note.`
    );
}
