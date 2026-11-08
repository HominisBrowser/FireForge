// SPDX-License-Identifier: EUPL-1.2
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { UnknownSlotError } from '../../errors/job.js';
import { getNodeErrorCode, toError } from '../../utils/errors.js';
import {
  authenticateAuthoredSnapshot,
  exportCapturedTree,
  materializeAuthoredSnapshot,
} from '../authored/index.js';
import { assertSourcePath } from '../authored/paths.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { sealToolIdentity } from './admission-tools.js';
import { retireBuildDerived } from './build-derived.js';
import { readCheckEvidence } from './check-evidence.js';
import { readCliCacheHook } from './environment.js';
import { executorFingerprint } from './evidence.js';
import { assertPackageUnchanged, PackageChangedError } from './package-signature.js';
import { phaseRuntimeIdentity } from './phase-identity.js';
import { assertProjectToolCompatibility } from './project-tools.js';
import type { ExecutionReport, JobRecord, ResourceVector, SealedReceipt } from './schema.js';
import { RESOURCE_NAMES } from './schema.js';
import {
  assertNoSlotUsers,
  auditSlot,
  SlotIntegrityError,
  SlotPreparationError,
} from './slot-audit.js';
import { invalidateBuildIdentity } from './slot-lock.js';
import type { SlotRecord } from './slot-types.js';
import { refreshFullBuildRequirement } from './source-build.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

export {
  acquireSlot,
  invalidateBuildIdentity,
  markSlotForAudit,
  SlotBusyError,
} from './slot-lock.js';

/** Read the slot identity maintained outside the materialized project. */
export async function readSlot(namespace: string, id: string): Promise<SlotRecord> {
  const directory = slotDirectory(namespace, id);
  let raw: unknown;
  try {
    raw = await readJson(join(directory, 'slot.json'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT')
      throw new UnknownSlotError(
        `Slot ${id} does not exist; fireforge slot list shows what exists, and fireforge slot create ${id} makes it`,
        error
      );
    throw error;
  }
  if (!raw || typeof raw !== 'object' || !('schemaVersion' in raw) || raw.schemaVersion !== 1)
    throw new Error('Unsupported slot metadata');
  const slot = raw as SlotRecord;
  if (
    slot.id !== id ||
    typeof slot.root !== 'string' ||
    typeof slot.pristineRepository !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(slot.pin) ||
    !Number.isSafeInteger(slot.generation) ||
    slot.generation < 0 ||
    !Number.isSafeInteger(slot.successfulBuildGeneration) ||
    slot.successfulBuildGeneration < 0 ||
    !Array.isArray(slot.inputs)
  )
    throw new Error('Invalid slot identity');
  for (const path of slot.inputs) {
    if (typeof path !== 'string') throw new Error('Invalid slot input');
    assertSourcePath(path);
  }
  if (
    basename(slot.root) !== 'root' ||
    (await realpath(dirname(slot.root))) !== (await realpath(directory)) ||
    (await realpath(slot.pristineRepository)) !== (await realpath(join(directory, 'engine.git')))
  )
    throw new Error('Slot metadata points outside its private execution directory');
  if (
    (await lstat(slot.root)).isSymbolicLink() ||
    (await lstat(join(slot.root, 'engine'))).isSymbolicLink()
  )
    throw new Error('Slot runtime roots cannot alias another checkout');
  return slot;
}

/** Every readable slot. One that cannot be read cannot carry a job either. */
export async function readSlots(namespace: string): Promise<SlotRecord[]> {
  let names: string[];
  try {
    names = await readdir(join(namespace, 'slots'));
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const slots = await Promise.all(
    names.map((name) => readSlot(namespace, name).catch(() => undefined))
  );
  return slots.filter((slot): slot is SlotRecord => slot !== undefined);
}

/** Replace the captured root files in a slot with a snapshot's. Caller holds the slot guard. */
export async function writeCapturedInputs(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot
): Promise<void> {
  const staging = join(slotDirectory(namespace, slot.id), `capture-${randomUUID()}`);
  try {
    await exportCapturedTree(snapshot, staging);
    for (const path of slot.inputs) await rm(join(slot.root, path), { force: true });
    for (const input of snapshot.inputs) {
      const path = join(staging, input.path);
      const target = resolve(slot.root, input.path);
      if (
        !target.startsWith(`${slot.root}${sep}`) ||
        /^(engine|node_modules|\.git|\.fireforge)(\/|$)/.test(input.path)
      )
        throw new Error('Captured input crosses runtime boundary');
      await mkdir(dirname(target), { recursive: true });
      await cp(path, target);
      await chmod(target, input.mode === '100755' ? 0o755 : 0o644);
    }
    slot.inputs = snapshot.inputs.map((input) => input.path);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Replace captured root inputs without replacing stable engine, objdir or dependency paths. Caller holds the slot guard.
 * Nothing changes before the pin check and the audit; a failure after that leaves the
 * slot's bytes uncertain, so it is a {@link SlotPreparationError}.
 */
export async function prepareSlot(
  namespace: string,
  slot: SlotRecord,
  snapshot: AuthoredSnapshot
): Promise<SlotRecord> {
  if (slot.quarantined !== null)
    throw new SlotIntegrityError(`Slot quarantined: ${slot.quarantined}`);
  if (slot.sourceId === snapshot.id) {
    await authenticateAuthoredSnapshot(snapshot, slot.pristineRepository);
    await auditSlot(namespace, slot);
    return slot;
  }
  if (slot.pin !== snapshot.pin.commit)
    throw new Error(
      `Slot ${slot.id} is on pristine pin ${slot.pin}, not ${snapshot.pin.commit}; create a new slot for source refresh`
    );
  if (slot.sourceId && slot.sourceId !== snapshot.id) await auditSlot(namespace, slot);
  try {
    if (slot.sourceId) await retireBuildDerived(namespace, slot, snapshot);
    await writeCapturedInputs(namespace, slot, snapshot);
    await materializeAuthoredSnapshot({
      snapshot,
      engineDir: join(slot.root, 'engine'),
      ledgerPath: join(slotDirectory(namespace, slot.id), 'materialization.json'),
      pristineRepository: slot.pristineRepository,
    });
    refreshFullBuildRequirement(slot, snapshot);
    slot.sourceId = snapshot.id;
    slot.generation += 1;
    delete slot.trustedBuild;
    delete slot.requiresAudit;
    slot.requiresBuild = slot.successfulBuildGeneration > 0 || slot.requiresBuild === true;
    await rm(join(slotDirectory(namespace, slot.id), 'derived.json'), { force: true });
    await writeDurable(join(slotDirectory(namespace, slot.id), 'snapshot.json'), snapshot);
    await writeDurable(join(slotDirectory(namespace, slot.id), 'slot.json'), slot);
    return slot;
  } catch (error) {
    throw new SlotPreparationError(`Source preparation interrupted: ${toError(error).message}`, {
      cause: error,
    });
  }
}

export {
  assertNoSlotUsers,
  auditSlot,
  SlotIntegrityError,
  SlotPreparationError,
} from './slot-audit.js';

/**
 * Seal successful evidence while exclusive slot ownership is still held. With
 * `passedSteps`, seals only those step indices, the ones that passed in a red
 * job, which has no terminal state to guard and leaves no receipt file: the
 * job's record carries it.
 */
export async function sealSlot(
  namespace: string,
  slot: SlotRecord,
  job: JobRecord,
  passedSteps?: readonly number[]
): Promise<SealedReceipt> {
  const indices = passedSteps ?? job.request.steps.map((_step, index) => index);
  if (passedSteps === undefined) assertSealable(job);
  const projectToolsDigest = await assertProjectToolCompatibility(slot.root);
  if (job.projectToolsDigest === undefined || projectToolsDigest !== job.projectToolsDigest)
    throw new Error('Project-installed tool code/dependency graph changed during the campaign');
  if (
    (await readFile(join(namespace, 'artifacts', job.id, 'cli-cache-hook.cjs'), 'utf8')) !==
    (await readCliCacheHook())
  )
    throw new Error('Owned CLI cache adapter changed during execution');
  const audited = await auditSlot(namespace, slot);
  await assertSlotUnused(slot, job.submittedAt);
  await assertSealablePackage(namespace, slot);
  const reports = await Promise.all(
    indices.map((index) =>
      readJson<ExecutionReport>(
        join(namespace, 'artifacts', job.id, `step-${index}-execution.json`)
      )
    )
  );
  const first = reports[0];
  if (first === undefined) throw new Error('Missing executor reports');
  if (
    reports.some(
      (entry) =>
        entry.toolsBefore !== first.toolsBefore ||
        entry.toolsAfter !== first.toolsBefore ||
        entry.environmentDigest !== first.environmentDigest
    )
  )
    throw new Error('Executor or environment changed between phases');
  const report: ExecutionReport = { ...first, steps: reports.flatMap((entry) => entry.steps) };
  if (
    report.jobId !== job.id ||
    report.toolsBefore !== report.toolsAfter ||
    report.toolsBefore !== job.executorToolsDigest ||
    report.toolsAfter !== (await executorFingerprint()) ||
    report.steps.length !== indices.length ||
    report.steps.some(
      (step, position) =>
        step.exitCode !== 0 ||
        step.command !== job.request.steps[indices[position] ?? -1]?.command ||
        step.index !== indices[position]
    )
  )
    throw new Error('Incomplete, changed-tool or mismatched executor evidence');
  const snapshot = await readJson<AuthoredSnapshot>(
    join(slotDirectory(namespace, slot.id), 'snapshot.json')
  );

  for (const evidence of report.steps.filter((step) => step.command === 'check')) {
    const step = job.request.steps[evidence.index];
    if (!step || !evidence.check) throw new Error('Complete observed check evidence is missing');
    await readCheckEvidence({
      namespace,
      job: job.id,
      index: evidence.index,
      root: slot.root,
      snapshot,
      step,
      cpu: job.stepResources?.[evidence.index]?.cpu ?? step.resources?.cpu ?? 1,
      expected: evidence.check,
    });
  }

  const { qualityToolsDigest, nativeToolsDigest } = await sealToolIdentity(
    namespace,
    slot,
    job,
    snapshot
  );
  const receipt: SealedReceipt = {
    schemaVersion: 1,
    jobId: job.id,
    sourceId: slot.sourceId,
    slotGeneration: slot.generation,
    runtimeIdentity: await phaseRuntimeIdentity(namespace, slot),
    successfulBuildGeneration: slot.successfulBuildGeneration,
    ...(slot.trustedBuild === undefined
      ? {}
      : { buildBaselineDigest: slot.trustedBuild.baselineDigest }),
    ...audited,
    toolsDigest: createHash('sha256')
      .update(
        JSON.stringify({
          executor: report.toolsAfter,
          project: projectToolsDigest,
          quality: qualityToolsDigest,
          native: nativeToolsDigest,
        })
      )
      .digest('hex'),
    projectToolsDigest,
    qualityToolsDigest,
    ...(job.toolIdentityTimings === undefined
      ? {}
      : { toolIdentityTimings: job.toolIdentityTimings }),
    ...(nativeToolsDigest === undefined ? {} : { nativeToolsDigest }),
    configDigest: createHash('sha256')
      .update(
        JSON.stringify({
          config: snapshot.config,
          build: job.request.build ?? { mode: 'dev', brand: snapshot.config.binaryName },
        })
      )
      .digest('hex'),
    environmentDigest: report.environmentDigest,
    resources: job.request.resources ?? peakResources(job),
    quiet: job.request.quiet,
    steps: report.steps,
    sealedAt: new Date().toISOString(),
  };
  if (passedSteps !== undefined) return receipt;
  assertSealable(job);
  await writeDurable(join(slotDirectory(namespace, slot.id), 'slot.json'), slot);
  const receiptPath = join(namespace, 'receipts', `${job.id}.json`);
  await writeDurable(receiptPath, receipt);
  try {
    assertSealable(job);
  } catch (error) {
    await rm(receiptPath, { force: true });
    throw error;
  }
  return receipt;
}

/**
 * What this job left running here can change what a later job reads, whatever
 * marker it hides. A bystander older than the job cannot be its work.
 */
async function assertSlotUnused(slot: SlotRecord, since: string): Promise<void> {
  try {
    await assertNoSlotUsers(slot.root, since);
  } catch (error) {
    throw new SlotIntegrityError(toError(error).message, { cause: error });
  }
}

/**
 * Evidence does not stand beside a package that moved since its build. A slot can
 * outlive this: it just needs that build again.
 */
async function assertSealablePackage(namespace: string, slot: SlotRecord): Promise<void> {
  try {
    await assertPackageUnchanged(slot);
  } catch (error) {
    if (error instanceof PackageChangedError) await invalidateBuildIdentity(namespace, slot, true);
    throw error;
  }
}

/** The largest vector any step of the job was admitted with, dimension by dimension. */
function peakResources(job: JobRecord): ResourceVector {
  const peak: ResourceVector = { cpu: 0, memory: 0, build: 0, browser: 0, display: 0 };
  for (const vector of job.stepResources ?? [])
    for (const name of RESOURCE_NAMES) peak[name] = Math.max(peak[name], vector[name]);
  return peak;
}

/** Completion and cancellation share the same terminal transition. */
function assertSealable(job: JobRecord): void {
  if (job.cancellationRequested || job.state !== 'sealing')
    throw new Error('Cancellation or invalid state prevents sealing');
}
