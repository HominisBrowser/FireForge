// SPDX-License-Identifier: EUPL-1.2
import { wantsMachineOutput } from '../cli-usage-error.js';
import type { JobStep } from '../core/jobs/schema.js';
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
      : status.waived.length > 0
        ? 'complete-with-waivers'
        : 'complete';

const decisionText = (decision: ProofDecision): string =>
  `${decision.kind} by ${decision.by} at ${decision.at}: ${decision.note}`;

/** One line per obligation, then one verdict. A person's decision always reads as one. */
export function printStatus(
  plan: ProofPlan,
  status: ProofStatus,
  extra: { steps?: readonly JobStep[]; notes?: readonly string[] } = {}
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
        },
        ...(extra.steps === undefined ? {} : { steps: extra.steps }),
        ...(extra.notes === undefined ? {} : { notes: extra.notes }),
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
  for (const removed of plan.removedTests)
    output(
      `  removed test: ${removed.path}${removed.from.length > 0 ? ` (was in ${removed.from.join(', ')})` : ''}`
    );
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
