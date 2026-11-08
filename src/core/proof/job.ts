// SPDX-License-Identifier: EUPL-1.2
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { JobStep } from '../jobs/schema.js';
import type { SlotRecord } from '../jobs/slot-types.js';
import { stepTraits } from '../jobs/step-traits.js';
import type { ObligationStatus } from './evidence.js';
import type { ProofPlan } from './types.js';

export interface ProofJob {
  steps: JobStep[];
  /** A slot only this work can use: the one holding the package it reads or the binary it extends. */
  slot?: string;
  /** Why the job does more or less than the plan's remaining steps. */
  notes: string[];
}

const needsWork = (entry: ObligationStatus): boolean =>
  entry.state === 'red' ||
  entry.state === 'stale' ||
  entry.state === 'blocked' ||
  entry.state === 'outstanding';

/**
 * The obligation a name picks out of a gate plan: `tiles` is `lane:tiles`, and
 * any other run obligation goes by its own ID, such as `stress:tiles` or `run:smoke`.
 *
 * @throws Outside a gate plan, when it has no such obligation, or when a person decides it
 */
export function namedObligation(plan: ProofPlan, name: string): string {
  if (plan.tier !== 'gate')
    throw new InvalidArgumentError('--lane names a gate obligation: add --tier gate', '--lane');
  const entry = plan.obligations.find((item) => item.id === name || item.id === `lane:${name}`);
  if (entry === undefined)
    throw new GeneralError(
      `proof-unknown-obligation: ${name} is not in this ${plan.tier} plan: ${plan.obligations.map((item) => item.id).join(', ')}`
    );
  if (entry.step === undefined)
    throw new GeneralError(
      `proof-lane-acceptance: ${entry.id} is a person's call, and nothing runs it. Look at it, then: fireforge prove accept ${entry.id} --tier gate --note <why>`
    );
  return entry.id;
}

/**
 * The job that finishes a plan: only the steps with no evidence yet, on a slot
 * that can run them. A step reading a package goes to the slot that has this
 * source's package or brings its own build, and a UI build goes where its binary is.
 * `only` narrows it to one obligation and whatever build that one needs.
 */
export function composeProofJob(
  plan: ProofPlan,
  statuses: readonly ObligationStatus[],
  slots: readonly SlotRecord[],
  toolchain: string | undefined,
  only?: string
): ProofJob {
  const remaining = new Set(
    statuses
      .filter((entry) => needsWork(entry) && (only === undefined || entry.id === only))
      .map((entry) => entry.id)
  );
  const notes: string[] = [];
  const steps: JobStep[] = [];
  const usable = slots.filter((slot) => slot.quarantined === null);
  // A binary of these inputs, by the host's current tools: anything else needs a full build.
  const anchored = usable.filter(
    (slot) =>
      slot.fullBuildAnchor?.digest === plan.compiled &&
      slot.requiresFullBuild !== true &&
      (toolchain === undefined || slot.objdirToolsDigest === toolchain)
  );
  const built = anchored.find(
    (slot) =>
      slot.sourceId === plan.source &&
      slot.trustedBuild?.sourceId === plan.source &&
      slot.requiresBuild !== true
  );
  const buildObligation = plan.obligations.find((entry) => entry.kind === 'build');
  const reads = plan.obligations.some(
    (entry) => remaining.has(entry.id) && stepTraits(entry.step).readsPackage
  );
  if (buildObligation !== undefined && reads && built === undefined)
    remaining.add(buildObligation.id);
  for (const entry of plan.obligations)
    if (remaining.has(entry.id) && entry.step !== undefined) steps.push(entry.step);
  let slot = built?.id;
  const uiBuild = steps.findIndex((step) => stepTraits(step).uiBuild);
  if (uiBuild >= 0) {
    if (anchored.length === 0) {
      steps[uiBuild] = { command: 'build', args: [] };
      notes.push('No slot has a binary of these compiled inputs, so this job builds one in full.');
    } else if (slot === undefined && anchored.length < usable.length) slot = anchored[0]?.id;
  }
  return { steps, ...(slot === undefined ? {} : { slot }), notes };
}
