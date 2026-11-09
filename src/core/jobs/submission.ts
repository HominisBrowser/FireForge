// SPDX-License-Identifier: EUPL-1.2
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import { authenticateAuthoredSnapshot } from '../authored/index.js';
import type { AuthoredSnapshot } from '../authored/types.js';
import { authorizeRequest } from './admission.js';
import { authenticateAdapterInputs } from './captured-inputs.js';
import { probeSessionRefusal } from './display-probe.js';
import { executorFingerprint } from './evidence.js';
import { assertKeptProfileOutside } from './kept-profile.js';
import {
  assertNativeBootstrapDisabled,
  needsNativeTools,
  nonStaticCheckSteps,
  readHostToolchain,
} from './native-tools.js';
import { assertReleaseRecipe } from './release-recipe.js';
import { retainSnapshot } from './retention.js';
import { buildRecipeDigest } from './runtime-state.js';
import {
  type CoordinatorConfig,
  derivedKey,
  derivedResources,
  type JobRecord,
  type JobRequest,
  jobSlot,
  type JobStep,
  type ResourceVector,
  terminal,
  validateRequest,
} from './schema.js';
import type { SlotRecord } from './slot-types.js';
import { readSlot } from './slots.js';
import { compiledSourceDigest } from './source-build.js';
import { stepTraits } from './step-traits.js';
import { assertReleaseRoom } from './storage.js';
import { readJson } from './store.js';

/** A step with internal builds or unknown footprints runs alone, on a host that has drained for it. */
function assertQuietWhereRequired(request: JobRequest, snapshot: AuthoredSnapshot): void {
  const quiet = (step: JobStep): boolean => step.quiet ?? request.quiet;
  for (const step of request.steps) {
    const traits = stepTraits(step);
    if ((traits.preTestBuild || traits.control) && !quiet(step))
      throw new Error(
        'Pre-test builds and controls require quiet admission; set quiet on the step, or split build and build-less test phases for bounded overlap'
      );
    const undeclared = step.command === 'check' ? nonStaticCheckSteps(snapshot) : [];
    if (undeclared.length > 0 && !quiet(step))
      throw new Error(
        `A check runs alone unless every project step is declared static. Declare "footprint": { "static": true } on: ${undeclared.join(', ')}; or set quiet on the step`
      );
  }
}

/** A slot this source can run on: the one it named, or any on its pin. */
async function submissionSlot(
  namespace: string,
  request: JobRequest,
  snapshot: AuthoredSnapshot
): Promise<SlotRecord> {
  if (request.slot !== undefined) {
    const slot = await readSlot(namespace, request.slot);
    if (slot.pin !== snapshot.pin.commit)
      throw new Error(
        `Slot ${slot.id} is on pristine pin ${slot.pin}, not ${snapshot.pin.commit}; create a slot for this pin`
      );
    return slot;
  }
  for (const name of await slotNames(namespace)) {
    try {
      const slot = await readSlot(namespace, name);
      if (slot.pin === snapshot.pin.commit) return slot;
    } catch {
      /* A slot that cannot be read cannot carry this job. */
    }
  }
  throw new Error(
    `No slot is on pristine pin ${snapshot.pin.commit}; provision them with: fireforge host init --slots <n>`
  );
}

/** Every slot's name on this host; none when there is no slot directory yet. */
async function slotNames(namespace: string): Promise<string[]> {
  try {
    return await readdir(join(namespace, 'slots'));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return [];
  }
}

/** An interactive run's kept profile lies outside the namespace and outside every slot's root, wherever that is. */
async function assertKeptProfiles(namespace: string, request: JobRequest): Promise<void> {
  const profiles = request.steps.flatMap((step) =>
    step.profile === undefined ? [] : [step.profile]
  );
  if (profiles.length === 0) return;
  const places: Record<string, string> = { 'the coordinator namespace': namespace };
  for (const name of await slotNames(namespace)) {
    const slot = await readSlot(namespace, name).catch(() => undefined);
    if (slot !== undefined) places[`slot ${slot.id}`] = slot.root;
  }
  for (const profile of profiles) await assertKeptProfileOutside(profile, places);
}

/** The vector each step is admitted with: what the caller stated, or an honest derived footprint. */
function resolveStepResources(
  request: JobRequest,
  snapshot: AuthoredSnapshot,
  config: CoordinatorConfig
): ResourceVector[] {
  const extras = snapshot.config.check?.extraSteps ?? [];
  const footprints = {
    cpu: BUILTIN_CHECK_STEPS + extras.reduce((sum, step) => sum + (step.footprint?.cpu ?? 1), 0),
    memory: Math.max(0, ...extras.map((step) => step.footprint?.memory ?? 0)),
  };
  return request.steps.map(
    (step) =>
      step.resources ??
      derivedResources(step, config.capacity, snapshot.config.build?.jobs, footprints)
  );
}

/** A check's own steps: status, verify, lint, typecheck, furnace-validate and token-coverage. */
const BUILTIN_CHECK_STEPS = 6;

export interface ValidatedSubmission {
  snapshot: AuthoredSnapshot;
  stepResources: ResourceVector[];
  compiledDigest: string;
}

/**
 * Everything a request has to satisfy before it is acknowledged, so a mistake
 * is a refusal at submit rather than a failure minutes into a job. Runs outside
 * the decision queue: this reads Git objects and hashes tools.
 */
export async function validateSubmission(options: {
  namespace: string;
  config: CoordinatorConfig;
  request: JobRequest;
  snapshot: AuthoredSnapshot;
  executorDigest: string;
}): Promise<ValidatedSubmission> {
  const { namespace, config, request, executorDigest } = options;
  if ((await executorFingerprint()) !== executorDigest)
    throw new Error(
      'Coordinator tool bytes changed after startup; wait for idle restart before submitting'
    );
  const slot = await submissionSlot(namespace, request, options.snapshot);
  const snapshot = await authenticateAuthoredSnapshot(options.snapshot, slot.pristineRepository);
  for (const step of request.steps) await authenticateAdapterInputs(snapshot, step);
  assertQuietWhereRequired(request, snapshot);
  await assertKeptProfiles(namespace, request);
  if (request.steps.some((step) => stepTraits(step).display)) {
    const refusal = await probeSessionRefusal();
    if (refusal !== undefined) throw new Error(refusal);
  }
  if (request.steps.some((step) => stepTraits(step).releaseBuild)) {
    await assertReleaseRecipe(snapshot, config);
    await assertReleaseRoom(namespace, slot.storage);
  }
  if (
    request.steps.some(
      (step) => step.command === 'qualify-native' || needsNativeTools(step, snapshot)
    )
  ) {
    await readHostToolchain(namespace);
    await assertNativeBootstrapDisabled(snapshot);
  }
  return {
    snapshot: await retainSnapshot(namespace, snapshot, slot.pristineRepository),
    stepResources: resolveStepResources(request, snapshot, config),
    compiledDigest: compiledSourceDigest(snapshot, buildRecipeDigest(request, snapshot)),
  };
}

/** Reconnect by key. A derived key attaches only to work that is live or passed. */
export function findDuplicate(
  jobs: Iterable<JobRecord>,
  request: JobRequest
): JobRecord | undefined {
  return [...jobs]
    .filter((job) => job.request.key === request.key)
    .findLast((job) =>
      derivedKey(request.key) ? !terminal(job.state) || job.state === 'passed' : true
    );
}

/**
 * Whether attaching to this job gives what a repeat asks for. A test's evidence
 * stands whatever its slot did next. A job that ends on a build was run for the
 * slot it leaves, and that is gone once the slot is rebuilt, reprepared or restored.
 */
export async function repeatStillStands(namespace: string, job: JobRecord): Promise<boolean> {
  if (
    job.state !== 'passed' ||
    !derivedKey(job.request.key) ||
    !stepTraits(job.request.steps.at(-1)).builds
  )
    return true;
  const id = jobSlot(job);
  if (id === undefined) return false;
  const slot = await readSlot(namespace, id).catch(() => undefined);
  return (
    slot !== undefined &&
    slot.quarantined === null &&
    slot.generation === job.receipt?.slotGeneration &&
    slot.successfulBuildGeneration === job.receipt.successfulBuildGeneration
  );
}

/** The cheap checks a request can fail without touching disk. */
export function assertRequestShape(
  request: unknown,
  snapshot: { id?: unknown },
  config: CoordinatorConfig
): asserts request is JobRequest {
  validateRequest(request);
  if (snapshot.id !== request.sourceId)
    throw new Error(
      `Snapshot ${String(snapshot.id)} is not the request's source ${request.sourceId}`
    );
  authorizeRequest(request, config);
}

/** Read a retained snapshot for the slot's preparation. */
export function readRetainedSnapshot(
  namespace: string,
  sourceId: string
): Promise<AuthoredSnapshot> {
  return readJson<AuthoredSnapshot>(join(namespace, 'snapshots', `${sourceId}.json`));
}
