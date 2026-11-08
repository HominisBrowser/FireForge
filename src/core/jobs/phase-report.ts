// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import type { AuthoredSnapshot } from '../authored/types.js';
import { currentResources, phaseQuiet } from './admission.js';
import { readCoordinatorConfig } from './admission-context.js';
import { verifyBuildDerived } from './build-derived.js';
import { recordSuccessfulBuild } from './build-identity.js';
import { phaseRuntimeIdentity } from './phase-identity.js';
import { judgeHostConditionRed, judgeLoadedQuietRed, type PhaseVerdict } from './phase-outcome.js';
import type {
  ExecutionReport,
  JobRecord,
  JobStep,
  SealedReceipt,
  StepEvidence,
  StepHostState,
  StepLoadPeak,
} from './schema.js';
import { jobSlot, quietLoadLimit } from './schema.js';
import { readSlot, sealSlot } from './slots.js';
import { stepOutputDirectory } from './step-environment.js';
import { stepTraits } from './step-traits.js';
import { readJson, writeDurable } from './store.js';

/** Bind adapter evidence to the actual completed package generation while slot/resource ownership is retained. */
export async function stampPhaseReport(
  namespace: string,
  job: JobRecord,
  step: JobStep
): Promise<void> {
  if (!job.phase) throw new Error('Missing completed phase');
  const reportPath = join(namespace, 'artifacts', job.id, `step-${job.phase.index}-execution.json`);
  const report = await readJson<ExecutionReport>(reportPath);
  const compiledRestore = report.steps.some((evidence) =>
    evidence.controlProof?.mutations.some(
      (mutation) => mutation.compiled && mutation.compiledRestoreBuild === 'done'
    )
  );
  const slotId = jobSlot(job);
  if (slotId === undefined) throw new Error('Completed phase has no assigned slot');
  if (compiledRestore || stepTraits(step).builds) {
    const slot = await readSlot(namespace, slotId);
    const snapshot = await readJson<AuthoredSnapshot>(
      join(namespace, 'slots', slot.id, 'snapshot.json')
    );
    await verifyBuildDerived(namespace, slot, snapshot);
  }
  await recordSuccessfulBuild(
    namespace,
    slotId,
    step,
    compiledRestore,
    report.steps[0]?.startedAt,
    job.nativeToolsDigest === undefined || job.phase.nonce === undefined
      ? undefined
      : {
          nativeToolsDigest: job.nativeToolsDigest,
          jobId: job.id,
          phase: job.phase.nonce,
        }
  );
  const runtimeAfter = await phaseRuntimeIdentity(namespace, await readSlot(namespace, slotId));

  for (const evidence of report.steps) {
    evidence.runtimeAfter = runtimeAfter;
    if (stepTraits(step).preTestBuild && !evidence.controlProof && !stepTraits(step).buildOnly)
      evidence.successfulBuildGeneration = runtimeAfter.successfulBuildGeneration;
  }
  await writeDurable(reportPath, report);
}

/**
 * A red phase's verdict read against the load it ran under and what changed on
 * the host, with both to record. A quiet phase's red under outside load is no
 * verdict on its step, nor is a red under a host change that step is exposed to.
 */
export async function judgeUnderLoad(
  namespace: string,
  job: JobRecord,
  verdict: PhaseVerdict
): Promise<{ judged: PhaseVerdict; peak?: StepLoadPeak; hostState?: StepHostState }> {
  const evidence = verdict.state === 'failed' ? await phaseEvidence(namespace, job) : undefined;
  const peak = evidence?.hostLoadPeak;
  const hostState = evidence?.hostState;
  const quiet = phaseQuiet(job);
  const config =
    quiet && peak !== undefined
      ? await readCoordinatorConfig(namespace).catch(() => undefined)
      : undefined;
  const loaded =
    config === undefined
      ? verdict
      : judgeLoadedQuietRed(verdict, {
          peak,
          limit: quietLoadLimit(config),
          cpu: currentResources(job).cpu,
        });
  const judged = judgeHostConditionRed(loaded, {
    state: hostState,
    quiet,
    headed: stepTraits(job.request.steps[job.phase?.index ?? 0]).display,
  });
  return {
    judged,
    ...(peak === undefined ? {} : { peak }),
    ...(hostState === undefined ? {} : { hostState }),
  };
}

/** The current phase's step evidence from its execution report. A report that cannot be read gives none. */
async function phaseEvidence(namespace: string, job: JobRecord): Promise<StepEvidence | undefined> {
  if (job.phase === undefined) return undefined;
  try {
    const report = await readJson<ExecutionReport>(
      join(namespace, 'artifacts', job.id, `step-${job.phase.index}-execution.json`)
    );
    return report.steps.at(-1);
  } catch {
    return undefined;
  }
}

/**
 * The evidence a red job still earned: every step before the current one that
 * passed, sealed by the same audit as a passed job, so a rerun needs only what
 * did not pass. A red or blocked step is never among them. An audit that fails
 * leaves none, and the slot's next admission deals with it.
 */
export async function sealPassedSteps(
  namespace: string,
  job: JobRecord
): Promise<SealedReceipt | undefined> {
  const judged = new Set((job.stepVerdicts ?? []).map((verdict) => verdict.step));
  const passed = Array.from({ length: job.phase?.index ?? 0 }, (_step, index) => index).filter(
    (index) => !judged.has(index)
  );
  const slot = jobSlot(job);
  if (passed.length === 0 || slot === undefined || job.cancellationRequested) return undefined;
  try {
    return await sealSlot(namespace, await readSlot(namespace, slot), job, passed);
  } catch {
    return undefined;
  }
}

/** Notes where a launched step writes, so `job status` can say. A step with no output directory adds nothing. */
export function recordStepOutput(namespace: string, draft: JobRecord, index: number): void {
  const step = draft.request.steps[index];
  const path = step && stepOutputDirectory(namespace, draft.id, index, step);
  if (path !== undefined) draft.outputs = [...(draft.outputs ?? []), { step: index, path }];
}
