// SPDX-License-Identifier: EUPL-1.2
import { defaultStepDeadline } from './phase-outcome.js';
import {
  type CoordinatorConfig,
  type JobRecord,
  type JobRequest,
  jobSlot,
  type JobStep,
  minimumResources,
  quietLoadLimit,
  RESOURCE_NAMES,
  type ResourceName,
  type ResourceVector,
  terminal,
} from './schema.js';
import { stepTraits } from './step-traits.js';

/** A campaign releases each vector before requesting the next, while retaining only its private slot. */
export function currentResources(job: JobRecord): ResourceVector {
  const index = job.phase?.index ?? 0;
  const step = job.request.steps[index];
  return job.stepResources?.[index] ?? step?.resources ?? minimumResources(step);
}
export const phaseQuiet = (job: JobRecord): boolean =>
  job.request.steps[job.phase?.index ?? 0]?.quiet ?? job.request.quiet;

/** Refuse a concurrency flag the adapter's admitted CPU does not cover. */
function assertConcurrency(step: JobStep, resources: ResourceVector): void {
  if (step.command !== 'check' && step.command !== 'build' && step.command !== 'test') return;
  const parallelism = step.args.flatMap((arg, index) => {
    if (arg === '--jobs' || arg === '-j') return [Number(step.args[index + 1])];
    if (arg.startsWith('--jobs=')) return [Number(arg.slice(7))];
    if (/^-j.+/.test(arg)) return [Number(arg.slice(2))];
    return [];
  });
  if (
    parallelism.some(
      (count) =>
        !Number.isSafeInteger(count) ||
        count < 1 ||
        count > resources.cpu ||
        (step.command === 'test' && count > 1)
    )
  )
    throw new Error(
      'Check/build/test concurrency exceeds admitted CPU capacity or supported single-harness admission'
    );
}

/** Check a request against the host's capacity and prevent understated adapter admission. */
export function authorizeRequest(request: JobRequest, config: CoordinatorConfig): void {
  if ((request.quiet || request.steps.some((step) => step.quiet)) && !config.legacyExcluded)
    throw new Error(
      'Quiet work requires excluding uncoordinated executables; run: fireforge host init'
    );
  for (const step of request.steps) {
    const minimum = minimumResources(step);
    const resources = step.resources ?? minimum;
    assertConcurrency(step, step.resources ?? { ...minimum, cpu: config.capacity.cpu });
    for (const name of RESOURCE_NAMES) {
      if (
        resources[name] < minimum[name] ||
        (request.resources !== undefined && resources[name] > request.resources[name]) ||
        resources[name] > config.capacity[name]
      )
        throw new Error(`Resource request exceeds capacity or understates adapter: ${name}`);
    }
  }
}

/** What the scheduler knows about one slot. */
export interface SlotView {
  id: string;
  pin?: string;
  sourceId?: string;
  quarantined: string | null;
  /** What the slot's compiled binary was built from, when it has one. */
  anchorDigest?: string;
  /** Its source needs a full build before anything can reuse its binary. */
  requiresFullBuild?: boolean;
  /** The source its current package is a build of, when it has a trusted one. */
  packagedSource?: string;
}

/** Everything admission reads besides the jobs themselves. */
export interface AdmissionContext {
  config: Pick<CoordinatorConfig, 'capacity' | 'quietLoad'>;
  /** The provisioned slots. Absent, named slots are taken at their word. */
  slots?: ReadonlyMap<string, SlotView>;
  /** Resources held by processes that outlived their phase. */
  held?: ResourceVector;
  /** A reason nothing may start: host quarantine or the disk floor. */
  blocked?: string;
  /** Why no window could be seen right now. Only a step with one waits on it. */
  displayDown?: string;
  /** The host's one-minute load average now, which a quiet phase waits on. Unknown, it waits on nothing. */
  hostLoad?: number;
  /** The clock, in epoch milliseconds, that bounds a quiet phase's wait for the load. */
  now?: number;
}

export interface AdmissionPlan {
  admit: Array<{ job: JobRecord; slot?: string }>;
  /** Why each waiting job is not in `admit`. */
  blocked: Map<string, string>;
  /** Queued jobs no slot can run and nothing under way will change that, and why. */
  refuse: Map<JobRecord, string>;
  /** Quiet phases the host's load kept from starting for their whole deadline, and why. */
  interrupt: Map<JobRecord, string>;
}

/** What a job asks of the slot it lands on. */
type JobWants = Pick<JobRecord, 'id' | 'request' | 'compiledDigest' | 'pin' | 'phase'>;

/**
 * What the job's next steps need the slot to already have: a binary its UI build
 * can extend, or a package its test can read. A full build needs neither, and
 * provides both to the steps after it.
 */
function buildNeed(job: JobWants): 'anchor' | 'package' | undefined {
  if (job.compiledDigest === undefined) return undefined;
  for (const step of job.request.steps.slice(job.phase?.index ?? 0)) {
    const traits = stepTraits(step);
    if (step.command === 'build' && !traits.uiBuild) return undefined;
    if (traits.requiresAnchor) return 'anchor';
    if (traits.readsPackage) return 'package';
  }
  return undefined;
}

/** Whether a slot's build state can serve a job. Preparing it for the job's source decides the rest. */
function slotServes(slot: SlotView, job: JobWants): boolean {
  const need = buildNeed(job);
  if (need === undefined) return true;
  if (need === 'package') return slot.packagedSource === job.request.sourceId;
  return (
    slot.anchorDigest === job.compiledDigest &&
    (slot.requiresFullBuild !== true || slot.sourceId !== job.request.sourceId)
  );
}

/** Another job whose remaining steps will leave a slot able to serve this one. */
function providerOf(job: JobWants, jobs: readonly JobRecord[]): JobRecord | undefined {
  const need = buildNeed(job);
  return jobs.find((other) => {
    if (other.id === job.id || terminal(other.state) || other.cancellationRequested) return false;
    const remaining = other.request.steps.slice(other.phase?.index ?? 0).map(stepTraits);
    return need === 'package'
      ? other.request.sourceId === job.request.sourceId && remaining.some((step) => step.builds)
      : other.compiledDigest === job.compiledDigest &&
          other.request.steps
            .slice(other.phase?.index ?? 0)
            .some((step) => step.command === 'build' && !stepTraits(step).uiBuild);
  });
}

/** What the job needs that no slot has, and the command that gets it. */
function neededBuild(job: JobWants): string {
  return buildNeed(job) === 'package'
    ? 'no package of this source, and no job is building one. Build it first: fireforge job run --build ui, or --build full if no slot has a binary of it'
    : 'no full build of these compiled inputs, and no job is building one. Build one first: fireforge job run --build full';
}

/**
 * Why nothing on this host can ever run a job as things stand: no slot can serve
 * it, or will once the work under way finishes. Undefined means it only has to wait.
 */
export function whyNoSlotCanRun(
  job: JobWants,
  slots: ReadonlyMap<string, SlotView>,
  jobs: readonly JobRecord[]
): string | undefined {
  if (buildNeed(job) === undefined || providerOf(job, jobs) !== undefined) return undefined;
  const named = jobSlot(job as JobRecord);
  const candidates = [...slots.values()].filter(
    (slot) =>
      slot.quarantined === null &&
      (named === undefined ? job.pin === undefined || slot.pin === job.pin : slot.id === named)
  );
  if (candidates.some((slot) => slotServes(slot, job))) return undefined;
  return `${named === undefined ? 'No slot can run this job: this host has' : `Slot ${named} cannot run this job: it has`} ${neededBuild(job)}`;
}

/**
 * Picks a slot for a job that named none, cheapest first: one already on the
 * job's source skips preparation, one whose anchor matches its compiled inputs
 * skips the full build, and any built slot only rebuilds what differs.
 */
export function chooseSlot(job: JobRecord, free: readonly SlotView[]): SlotView | undefined {
  const usable = free.filter(
    (slot) => (job.pin === undefined || slot.pin === job.pin) && slotServes(slot, job)
  );
  return (
    usable.find((slot) => slot.sourceId === job.request.sourceId) ??
    usable.find(
      (slot) => job.compiledDigest !== undefined && slot.anchorDigest === job.compiledDigest
    ) ??
    usable.find((slot) => slot.anchorDigest !== undefined) ??
    usable[0]
  );
}

/** Lanes are never traded for one another; CPU and memory are fungible across jobs. */
const LANES: readonly ResourceName[] = ['build', 'browser', 'display'];

/** Lists quarantined slots and what brings them back. */
function quarantineNote(slots: readonly SlotView[]): string {
  const names = slots.map((slot) => slot.id).join(' ');
  const reasons = slots.map((slot) => `${slot.id}: ${slot.quarantined ?? ''}`).join('; ');
  return `quarantined ${reasons}. Run: fireforge slot restore ${names}`;
}

/** Why a job with no named slot has none yet: what it needs, who has it, and what would free it. */
function whyWaiting(
  job: JobRecord,
  slots: readonly SlotView[],
  occupied: ReadonlyMap<string, string>,
  jobs: readonly JobRecord[]
): { blocked: string } | { refuse: string } {
  const onPin = slots.filter((slot) => job.pin === undefined || slot.pin === job.pin);
  const quarantined = onPin.filter((slot) => slot.quarantined !== null);
  const able = onPin.find(
    (slot) => slot.quarantined === null && occupied.has(slot.id) && slotServes(slot, job)
  );
  if (able !== undefined && buildNeed(job) !== undefined)
    return {
      blocked: `Waiting for slot ${able.id}, which has the build this job needs, held by job ${occupied.get(able.id) ?? ''}`,
    };
  const provider = providerOf(job, jobs);
  if (buildNeed(job) !== undefined && provider !== undefined)
    return { blocked: `Waiting for job ${provider.id}, which builds what this job needs` };
  if (buildNeed(job) !== undefined && job.state === 'queued') {
    const refusal = whyNoSlotCanRun(job, new Map(slots.map((slot) => [slot.id, slot])), jobs);
    if (refusal !== undefined)
      return {
        refuse: quarantined.length === 0 ? refusal : `${refusal}; ${quarantineNote(quarantined)}`,
      };
  }
  const busy = onPin.filter((slot) => occupied.has(slot.id));
  const parts = [
    ...(busy.length === 0 ? [] : [`in use: ${busy.map((slot) => slot.id).join(', ')}`]),
    ...(quarantined.length === 0 ? [] : [quarantineNote(quarantined)]),
  ];
  return {
    blocked: `Waiting for a free slot on this source pin; ${parts.join('; ') || 'none exist'}`,
  };
}

/** A slot a job can take now, or why it cannot. */
function slotOutcome(
  job: JobRecord,
  context: AdmissionContext,
  occupied: ReadonlyMap<string, string>,
  jobs: readonly JobRecord[]
): { slot?: string; blocked?: string; refuse?: string } {
  const named = jobSlot(job);
  if (named === undefined) {
    const slots = [...(context.slots?.values() ?? [])];
    const free = slots.filter((view) => view.quarantined === null && !occupied.has(view.id));
    const chosen = chooseSlot(job, free);
    return chosen === undefined ? whyWaiting(job, slots, occupied, jobs) : { slot: chosen.id };
  }
  const view = context.slots?.get(named);
  if (context.slots !== undefined && view === undefined)
    return { blocked: `Slot ${named} does not exist` };
  if (view?.quarantined != null && job.state === 'queued')
    return {
      blocked: `Slot ${named} is quarantined: ${view.quarantined}. Run: fireforge slot restore ${named}`,
    };
  const owner = occupied.get(named);
  if (owner !== undefined && owner !== job.id)
    return { blocked: `Slot ${named} is in use by job ${owner}` };
  return { slot: named };
}

/** Why a job's vector does not fit, reserving what it waits for so later jobs cannot take it. */
function resourceBlock(
  resources: ResourceVector,
  used: ResourceVector,
  capacity: ResourceVector,
  reserved: Set<ResourceName>
): string | undefined {
  const short = RESOURCE_NAMES.filter((name) => used[name] + resources[name] > capacity[name]);
  const contested = RESOURCE_NAMES.filter((name) => resources[name] > 0 && reserved.has(name));
  if (short.length === 0 && contested.length === 0) return undefined;
  const lanes = short.filter((name) => LANES.includes(name));
  for (const name of lanes.length > 0 ? lanes : short) reserved.add(name);
  return short.length > 0
    ? `Waiting for ${short.join(', ')}`
    : `Queued behind an earlier job for ${contested.join(', ')}`;
}

/**
 * Why a drained host still cannot start a quiet phase: load from outside the
 * coordinator at or above the quiet limit. The wait is bounded by the step's
 * deadline, counted from when the phase queued; past it, nothing ran, so the
 * job ends with no verdict on the step.
 */
function loadBlock(
  job: JobRecord,
  context: AdmissionContext
): { blocked: string } | { interrupt: string } | undefined {
  const limit = quietLoadLimit(context.config);
  const load = context.hostLoad;
  if (load === undefined || load < limit) return undefined;
  const step = job.request.steps[job.phase?.index ?? 0];
  const seconds = step?.deadlineSeconds ?? (step === undefined ? 3600 : defaultStepDeadline(step));
  const waited = (context.now ?? Date.now()) - Date.parse(job.updatedAt);
  const reading = `one-minute load ${load.toFixed(2)} is at or above the quiet limit ${String(limit)}`;
  return waited > seconds * 1000
    ? {
        interrupt: `Host load kept this quiet phase from starting for its ${String(seconds)}s deadline: ${reading}`,
      }
    : { blocked: `host-load: ${reading}` };
}

/**
 * Atomic phase admission in ticket order, work-conserving: a job that cannot
 * start reserves what it is waiting for and later jobs may pass only if they
 * fit and touch nothing reserved. A job waiting on a lane reserves the lane
 * alone, since CPU cannot free up for it before the lane does; once only CPU or
 * memory blocks it, those are reserved and it starts as soon as they drain, so
 * a stream of small jobs cannot starve it. A quiet waiter drains the host, then
 * waits for the load from outside the coordinator to fall below the quiet limit.
 */
export function planAdmission(
  jobs: readonly JobRecord[],
  context: AdmissionContext
): AdmissionPlan {
  const plan: AdmissionPlan = {
    admit: [],
    blocked: new Map(),
    refuse: new Map(),
    interrupt: new Map(),
  };
  const active = jobs.filter(
    (job) => job.phase?.active === true && (job.state === 'running' || job.state === 'sealing')
  );
  const used: ResourceVector = { cpu: 0, memory: 0, build: 0, browser: 0, display: 0 };
  for (const name of RESOURCE_NAMES) {
    used[name] += context.held?.[name] ?? 0;
    for (const job of active) used[name] += currentResources(job)[name];
  }
  const occupied = new Map<string, string>();
  for (const job of jobs) {
    const slot = jobSlot(job);
    if (slot !== undefined && (job.state === 'running' || job.state === 'sealing'))
      occupied.set(slot, job.id);
  }
  const waiting = jobs
    .filter(
      (job) =>
        !job.cancellationRequested &&
        (job.state === 'queued' ||
          ((job.state === 'running' || job.state === 'sealing') && job.phase?.active === false))
    )
    .sort((a, b) => (a.phase?.ticket ?? 0) - (b.phase?.ticket ?? 0));
  const blockAll = (reason: string, from: readonly JobRecord[]): void => {
    for (const job of from) plan.blocked.set(job.id, reason);
  };
  const quietActive = active.find(phaseQuiet);
  const everyone =
    context.blocked ??
    (quietActive === undefined
      ? undefined
      : `Waiting for the quiet phase of job ${quietActive.id}`);
  if (everyone !== undefined) {
    blockAll(everyone, waiting);
    return plan;
  }
  const reserved = new Set<ResourceName>();
  for (const [index, job] of waiting.entries()) {
    const { slot, blocked, refuse } = slotOutcome(job, context, occupied, jobs);
    if (refuse !== undefined) {
      plan.refuse.set(job, refuse);
      continue;
    }
    if (blocked !== undefined) {
      plan.blocked.set(job.id, blocked);
      continue;
    }
    if (phaseQuiet(job)) {
      const loaded = active.length + plan.admit.length === 0 ? loadBlock(job, context) : undefined;
      if (active.length + plan.admit.length > 0)
        plan.blocked.set(job.id, 'Draining the host for this quiet phase');
      else if (loaded === undefined)
        plan.admit.push({ job, ...(slot === undefined ? {} : { slot }) });
      else if ('interrupt' in loaded) plan.interrupt.set(job, loaded.interrupt);
      else plan.blocked.set(job.id, loaded.blocked);
      blockAll(`Waiting for the quiet phase of job ${job.id}`, waiting.slice(index + 1));
      return plan;
    }
    const resources = currentResources(job);
    // Nothing to reserve: no job admitted now could wake the display, and only windows wait for it.
    if (resources.display > 0 && context.displayDown !== undefined) {
      plan.blocked.set(job.id, `display: ${context.displayDown}`);
      continue;
    }
    const waitingFor = resourceBlock(resources, used, context.config.capacity, reserved);
    if (waitingFor !== undefined) {
      plan.blocked.set(job.id, waitingFor);
      continue;
    }
    plan.admit.push({ job, ...(slot === undefined ? {} : { slot }) });
    if (slot !== undefined) occupied.set(slot, job.id);
    for (const name of RESOURCE_NAMES) used[name] += resources[name];
  }
  return plan;
}

/** Whether a step reads the generated build configuration a slot's preparation writes. */
export const needsBuildDerived = (step: JobStep | undefined): boolean =>
  step?.command === 'package' || stepTraits(step).builds;
