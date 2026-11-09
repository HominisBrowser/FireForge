// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { toError } from '../../utils/errors.js';
import { authenticateAuthoredSnapshot } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { needsBuildDerived } from './admission.js';
import { preparePhaseTools } from './admission-tools.js';
import { prepareBuildDerived } from './build-derived.js';
import { readHostToolchain } from './native-tools.js';
import {
  markPackageVerified,
  PackageChangedError,
  verifyPackageOncePerPhase,
} from './package-signature.js';
import { withinDeadline } from './phase-outcome.js';
import { assertProjectToolCompatibility } from './project-tools.js';
import { seedRuntimeState } from './runtime-state.js';
import { type JobRecord, type JobStep, terminal } from './schema.js';
import { reviewDetached } from './slot-detached.js';
import type { SlotRecord } from './slot-types.js';
import {
  assertNoSlotUsers,
  auditSlot,
  invalidateBuildIdentity,
  prepareSlot,
  readSlot,
  SlotIntegrityError,
  SlotPreparationError,
} from './slots.js';
import { compiledControl } from './step-build.js';
import { stepTraits } from './step-traits.js';
import { readJournal, readJson, writeDurable } from './store.js';
import { readRetainedSnapshot } from './submission.js';

/** How long a preparation or a seal may take: it has no process of its own to signal. */
export const SLOT_WORK_DEADLINE_MS = 30 * 60_000;

/** A step this slot's build state cannot run. No process started, so this says nothing about the step. */
export class SlotCannotServeError extends Error {
  override readonly name = 'SlotCannotServeError';
}

/** When the last job on a slot was submitted: whatever it left cannot be older. */
async function lastJobSubmitted(namespace: string, slot: string): Promise<string | undefined> {
  const earlier = [...(await readJournal(namespace)).values()].filter(
    (entry) => entry.slot === slot && terminal(entry.state)
  );
  return earlier.sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)?.submittedAt;
}

/** A process the last job left in a slot is the slot's problem, whichever job finds it. */
async function assertUnused(namespace: string, slot: SlotRecord): Promise<void> {
  try {
    await assertNoSlotUsers(slot.root, await lastJobSubmitted(namespace, slot.id));
  } catch (error) {
    throw new SlotIntegrityError(toError(error).message, { cause: error });
  }
}

/** Brings the slot to a job's source, auditing first if the previous job ended unsealed. `record` journals the project tools this source runs with. */
export async function prepareJobSource(
  namespace: string,
  job: JobRecord,
  slotId: string,
  record: (projectToolsDigest: string) => Promise<void>
): Promise<void> {
  const slot = await readSlot(namespace, slotId);
  if (slot.quarantined !== null)
    throw new SlotIntegrityError(`Slot quarantined: ${slot.quarantined}`);
  await reviewDetached(namespace, slot);
  const snapshot = await readRetainedSnapshot(namespace, job.request.sourceId);
  const expired = (): Error =>
    new SlotPreparationError(
      `Source preparation did not finish within ${String(SLOT_WORK_DEADLINE_MS / 60_000)} minutes`
    );
  if (slot.sourceId !== snapshot.id)
    await withinDeadline(prepareSlot(namespace, slot, snapshot), SLOT_WORK_DEADLINE_MS, expired);
  else {
    if (slot.requiresAudit === true) {
      await authenticateAuthoredSnapshot(snapshot, slot.pristineRepository);
      await withinDeadline(auditSlot(namespace, slot), SLOT_WORK_DEADLINE_MS, expired);
      await assertUnused(namespace, slot);
      delete slot.requiresAudit;
      await writeDurable(join(namespace, 'slots', slot.id, 'slot.json'), slot);
    }
    await writeDurable(join(namespace, 'slots', slot.id, 'snapshot.json'), snapshot);
  }
  await record(await assertProjectToolCompatibility(slot.root));
  await seedRuntimeState(namespace, await readSlot(namespace, slot.id), snapshot, job.request);
}

/**
 * A package that moved since its build cannot be vouched for by anything a UI
 * build or a test does, so the slot goes back to needing a full build.
 *
 * @throws {SlotCannotServeError} When the package moved
 */
async function assertPackageTrusted(
  namespace: string,
  job: JobRecord,
  slot: SlotRecord,
  step: JobStep | undefined,
  nonce: string
): Promise<void> {
  const traits = stepTraits(step);
  if (!traits.requiresAnchor && !traits.readsPackage) return;
  // The step before it just signed this package, so nothing has had time to move it.
  // One that went red or was blocked signed nothing.
  const previous = (job.phase?.index ?? 0) - 1;
  if (
    stepTraits(job.request.steps[previous]).builds &&
    !(job.stepVerdicts ?? []).some((verdict) => verdict.step === previous)
  ) {
    markPackageVerified(job.id, nonce);
    return;
  }
  try {
    await verifyPackageOncePerPhase(slot, job.id, nonce);
  } catch (error) {
    if (!(error instanceof PackageChangedError)) throw error;
    await invalidateBuildIdentity(namespace, slot, true);
    throw new SlotCannotServeError(`${error.message}. Rebuild it: fireforge job run --build full`);
  }
}

/**
 * Forgets what a step is about to overwrite, durably before it launches: a build
 * that dies leaves no record of the binary it overwrote.
 */
async function invalidateBeforeLaunch(
  namespace: string,
  job: JobRecord,
  slot: SlotRecord,
  step: JobStep | undefined,
  snapshot: AuthoredSnapshot
): Promise<void> {
  const traits = stepTraits(step);
  // Qualification runs configure, so whatever package this slot had is no longer known current.
  // An object directory it creates is these tools' own; one a clone brought keeps its record.
  if (step?.command === 'qualify-native')
    await invalidateBuildIdentity(
      namespace,
      slot,
      false,
      slot.objdirToolsDigest ?? (await readHostToolchain(namespace)).digest
    );
  if (!traits.builds && !traits.control) return;
  const compiled =
    (step?.command === 'build' && !traits.uiBuild) ||
    (traits.control && step !== undefined && (await compiledControl(snapshot, step)));
  if (traits.builds || compiled)
    await invalidateBuildIdentity(
      namespace,
      slot,
      compiled,
      job.nativeToolsDigest === undefined ? undefined : (await readHostToolchain(namespace)).digest
    );
}

/**
 * Everything between a prepared slot and a launch, in order: the package vouched
 * for, the phase's tools, the build state checked, derived inputs made, and what
 * the step will overwrite forgotten. Nothing changes before a refusal.
 *
 * @returns The slot as the step will launch on it
 * @throws {SlotCannotServeError} When this slot's build state cannot run the step
 */
export async function readyPhaseSlot(
  namespace: string,
  job: JobRecord,
  slotId: string,
  nonce: string,
  assertLive: () => void
): Promise<SlotRecord> {
  const slot = await readSlot(namespace, slotId);
  const step = job.request.steps[job.phase?.index ?? 0];
  await assertPackageTrusted(namespace, job, slot, step, nonce);
  await preparePhaseTools(namespace, job, slot, step);
  // Refused before anything changes: this slot's build state cannot run this step.
  if (slot.requiresFullBuild === true && stepTraits(step).requiresAnchor)
    throw new SlotCannotServeError(
      'Current compiled/generator inputs require an admitted full build before UI-only build or pre-test faster build'
    );
  const snapshot = await readJson<AuthoredSnapshot>(
    join(namespace, 'slots', slot.id, 'snapshot.json')
  );
  if (needsBuildDerived(step)) await prepareBuildDerived(namespace, slot, snapshot);
  assertLive();
  await invalidateBeforeLaunch(namespace, job, slot, step, snapshot);
  return slot;
}
