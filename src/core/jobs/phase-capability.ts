// SPDX-License-Identifier: EUPL-1.2
import { currentResources } from './admission.js';
import { verifyPackageOncePerPhase } from './package-signature.js';
import type { RpcRequest } from './protocol.js';
import type { JobRecord } from './schema.js';
import { jobSlot } from './schema.js';
import { readSlot } from './slots.js';
import { stepTraits } from './step-traits.js';

/**
 * The per-phase token and nonce authorize a CLI descendant. They stop a stale
 * CLI from an earlier phase acting on this one, and accidental direct execution.
 * Same-user processes are trusted beyond that.
 */
function assertExecutorCapability(
  job: JobRecord | undefined,
  request: Extract<RpcRequest, { token: string }>
): asserts job is JobRecord & { phase: NonNullable<JobRecord['phase']> } {
  if (
    job?.state !== 'running' ||
    job.phase === undefined ||
    job.executionToken !== request.token ||
    job.phase.nonce !== request.phase ||
    job.process === undefined ||
    !(
      job.request.steps[job.phase.index]?.command === request.command ||
      (job.request.steps[job.phase.index]?.command === 'check' &&
        ['status', 'verify', 'lint', 'typecheck', 'furnace'].includes(request.command))
    )
  )
    throw new Error('Executor capability refused');
}

/**
 * Return live owned phase metadata after capability and runtime provenance
 * checks. Served from durable state outside the decision queue, so another
 * job's work cannot make this time out.
 */
export async function authorizeExecution(
  namespace: string,
  job: JobRecord | undefined,
  request: Extract<RpcRequest, { token: string }>
): Promise<{ root: string; slot: string; [key: string]: unknown }> {
  assertExecutorCapability(job, request);
  const slotId = jobSlot(job);
  if (slotId === undefined) throw new Error('Executor capability refused');
  const slot = await readSlot(namespace, slotId);
  const step = job.request.steps[job.phase.index];
  if (
    stepTraits(step).readsPackage &&
    (slot.requiresBuild ||
      slot.requiresFullBuild ||
      slot.fullBuildAnchor === undefined ||
      slot.trustedBuild?.sourceId !== slot.sourceId ||
      slot.trustedBuild.slotGeneration !== slot.generation ||
      slot.trustedBuild.successfulBuildGeneration !== slot.successfulBuildGeneration)
  )
    throw new Error(
      'Runtime source requires a fresh admitted build before testing, running or packaging'
    );
  if (stepTraits(step).readsPackage)
    await verifyPackageOncePerPhase(slot, job.id, job.phase.nonce ?? '');
  return {
    jobId: job.id,
    stepIndex: job.phase.index,
    stepArgs: step?.args,
    cpu: currentResources(job).cpu,
    epoch: job.epoch,
    slot: slotId,
    root: slot.root,
    quiet: job.request.quiet,
    qualityToolsDigest: job.qualityToolsDigest,
    nativeToolsDigest: job.nativeToolsDigest,
    sourceId: job.request.sourceId,
    nodeExecutable: process.execPath,
    gitExecutable: job.gitExecutable,
    gitExecPath: job.gitExecPath,
  };
}

/** A CLI's uncertain teardown can only speak for the exact live phase it belongs to. */
export function assertCleanupReport(
  job: JobRecord | undefined,
  request: Extract<RpcRequest, { token: string }>
): asserts job is JobRecord {
  assertExecutorCapability(job, request);
  if (
    typeof request.reason !== 'string' ||
    request.reason.length === 0 ||
    request.reason.length > 4096
  )
    throw new Error('Invalid process cleanup uncertainty reason');
}
