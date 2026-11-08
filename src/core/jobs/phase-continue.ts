// SPDX-License-Identifier: EUPL-1.2
/** A job that goes on past a red step: when it may, where it goes next, and what it says at the end. */
import { SlotCannotServeError } from './phase-preparation.js';
import type { Settlement } from './phase-settlement.js';
import {
  type JobRecord,
  jobSlot,
  type JobState,
  type JobStep,
  type StepHostState,
  type StepLoadPeak,
  type StepVerdict,
} from './schema.js';
import { assertNoSlotUsers, auditSlot, readSlot } from './slots.js';
import { stepTraits } from './step-traits.js';

/** A red step's verdict, kept on the job as it goes on. */
export const redVerdict = (
  job: JobRecord,
  reason: string | undefined,
  peak: StepLoadPeak | undefined,
  hostState?: StepHostState
): StepVerdict => ({
  step: job.phase?.index ?? 0,
  state: 'red',
  reason: reason ?? 'red',
  ...(peak === undefined ? {} : { hostLoadPeak: peak }),
  ...(hostState === undefined ? {} : { hostState }),
});

/** Why a job that went on past reds failed: how many, then each red step's own reason. */
export function verdictSummary(job: JobRecord, verdicts: readonly StepVerdict[]): string {
  const reds = verdicts.filter((verdict) => verdict.state === 'red');
  const blocked = verdicts.length - reds.length;
  const head = `${String(reds.length)} of ${String(job.request.steps.length)} steps red${blocked > 0 ? `, ${String(blocked)} blocked` : ''}`;
  return [
    head,
    ...reds.map(
      (verdict) =>
        `step ${String(verdict.step)} (${job.request.steps[verdict.step]?.command ?? 'step'}): ${verdict.reason}`
    ),
  ].join('; ');
}

/**
 * A step that the slot an earlier red step left cannot serve, in a job that goes
 * on past reds. Nothing launched, so it is blocked rather than red.
 */
export const blockedAtLaunch = (job: JobRecord, error: unknown, launched: boolean): boolean =>
  error instanceof SlotCannotServeError &&
  job.request.continueOnFailure === true &&
  (job.stepVerdicts ?? []).length > 0 &&
  !job.cancellationRequested &&
  !launched;

/**
 * Whether a red phase lets its job go on: only a plain red, in a job that asked
 * for it, on a slot whose processes are all accounted for and whose audit holds,
 * the one the next job's admission would make. Anything else ends the job as a red does.
 */
export async function goesOnPastRed(
  namespace: string,
  job: JobRecord,
  judged: { state: JobState; quarantine?: string },
  settled: Settlement
): Promise<boolean> {
  const slot = jobSlot(job);
  if (
    job.request.continueOnFailure !== true ||
    judged.state !== 'failed' ||
    judged.quarantine !== undefined ||
    settled.uncertain !== undefined ||
    settled.holds.length > 0 ||
    settled.detached !== undefined ||
    job.cancellationRequested ||
    slot === undefined
  )
    return false;
  try {
    const record = await readSlot(namespace, slot);
    await auditSlot(namespace, record);
    await assertNoSlotUsers(record.root, job.submittedAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where a job that goes on past a red step goes next: the first step from `from`
 * on that can still run, and those before it that cannot. A step that reads the
 * package, or builds over the anchor, is blocked once the last step that built it
 * went red or was blocked, or once a step reading it was blocked because the
 * package could not be vouched for. A later build that passes makes it whole again.
 */
export function nextRunnableStep(
  steps: readonly JobStep[],
  verdicts: readonly StepVerdict[],
  from: number
): { index: number; blocked: StepVerdict[] } {
  const known = new Map(verdicts.map((verdict) => [verdict.step, verdict]));
  const blocked: StepVerdict[] = [];
  /** The step that left no trustworthy package, if one did. */
  let broken: number | undefined;
  for (let index = 0; index < steps.length; index += 1) {
    const traits = stepTraits(steps[index]);
    const needsPackage = traits.readsPackage || traits.requiresAnchor;
    if (index >= from) {
      if (broken === undefined || !needsPackage) return { index, blocked };
      const cause = steps[broken];
      const verdict: StepVerdict = {
        step: index,
        state: 'blocked',
        reason: `Blocked by step ${String(broken)} (${cause?.command ?? 'step'}), which ${known.get(broken)?.state === 'red' ? 'went red' : 'could not run'}`,
      };
      blocked.push(verdict);
      known.set(index, verdict);
    }
    const verdict = known.get(index);
    if (traits.builds) broken = verdict === undefined ? undefined : index;
    else if (verdict?.state === 'blocked' && needsPackage) broken ??= index;
  }
  return { index: steps.length, blocked };
}

/**
 * Where a job goes after its current phase ends with these verdicts: the next
 * step that can run, the verdicts it holds without the steps they block, and with them.
 */
export function pastPhase(
  job: JobRecord,
  verdicts: readonly StepVerdict[]
): { index: number; known: StepVerdict[]; all: StepVerdict[] } {
  const known = [...(job.stepVerdicts ?? []), ...verdicts];
  const { index, blocked } = nextRunnableStep(
    job.request.steps,
    known,
    (job.phase?.index ?? 0) + 1
  );
  return { index, known, all: [...known, ...blocked] };
}
