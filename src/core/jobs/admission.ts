// SPDX-License-Identifier: EUPL-1.2
import { adapterJobs } from './adapter-arguments.js';
import { quietPhaseText } from './job-progress.js';
import { defaultStepDeadline } from './phase-outcome.js';
import { joinsQuiet, quietMode } from './quiet-phase.js';
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
  const jobs = adapterJobs(step);
  if (jobs === undefined) return;
  if (jobs > resources.cpu || (step.command === 'test' && jobs > 1))
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
  /** What a build replication involving this slot is doing; only {@link SlotView.replicationJob} may use it meanwhile. */
  replicating?: string;
  /** The job that relocates a replicated build here, the one job this slot admits while replicating. */
  replicationJob?: string;
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
export function buildNeed(job: JobWants): 'anchor' | 'package' | undefined {
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
export function slotServes(slot: SlotView, job: JobWants): boolean {
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
function neededBuild(job: JobWants, quarantined: readonly SlotView[] = []): string {
  const package_ = buildNeed(job) === 'package';
  if (quarantined.length > 0) {
    const names = quarantined.map((slot) => slot.id).join(' ');
    const reasons = quarantined.map((slot) => `${slot.id}: ${slot.quarantined ?? ''}`).join('; ');
    return `${package_ ? 'a package of this source' : 'a full build of these compiled inputs'} only in quarantined slot${quarantined.length === 1 ? '' : 's'} (${reasons}). Restore ${quarantined.length === 1 ? 'it' : 'one'}: fireforge slot restore ${names}, adding --stop-orphans when a leftover process holds the slot`;
  }
  return package_
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
  const eligible = [...slots.values()].filter((slot) =>
    named === undefined ? job.pin === undefined || slot.pin === job.pin : slot.id === named
  );
  const candidates = eligible.filter((slot) => slot.quarantined === null);
  if (candidates.some((slot) => slotServes(slot, job))) return undefined;
  const hidden = eligible.filter((slot) => slot.quarantined !== null && slotServes(slot, job));
  return `${named === undefined ? 'No slot can run this job: this host has' : `Slot ${named} cannot run this job: it has`} ${neededBuild(job, hidden)}`;
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
  const replicating = onPin.find(
    (slot): slot is SlotView & { replicating: string } =>
      slot.quarantined === null && slot.replicating !== undefined && slotServes(slot, job)
  );
  if (replicating !== undefined && buildNeed(job) !== undefined)
    return {
      blocked: `Waiting while ${replicating.replicating}, so more than one slot can serve this job`,
    };
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
    const free = slots.filter(
      (view) =>
        view.quarantined === null && view.replicating === undefined && !occupied.has(view.id)
    );
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
  if (view?.replicating !== undefined && view.replicationJob !== job.id)
    return { blocked: `Slot ${named} is busy ${view.replicating}` };
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

/** What a window waits for when another job's step holds the host's one display: who holds it. */
function displayWait(
  resources: ResourceVector,
  used: ResourceVector,
  capacity: ResourceVector,
  running: readonly JobRecord[]
): string | undefined {
  if (resources.display === 0 || used.display + resources.display <= capacity.display)
    return undefined;
  const holder = running.find((other) => currentResources(other).display > 0);
  return holder === undefined
    ? undefined
    : `Waiting for the display, held by job ${holder.id} step ${String(holder.phase?.index ?? 0)}`;
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
 * Why a static check cannot start beside the shared quiet phase `held` names: it would claim a
 * lane, the load cannot be read, or the load with its CPU and the CPU admitted
 * beside the phase in this pass would reach the quiet limit.
 */
function besideBlock(
  held: string | undefined,
  resources: ResourceVector,
  beside: number,
  context: AdmissionContext
): string | undefined {
  if (held === undefined) return undefined;
  if (LANES.some((name) => resources[name] > 0))
    return `${held}; only a static check runs beside it`;
  const limit = quietLoadLimit(context.config);
  const load = context.hostLoad;
  if (load === undefined)
    return `${held}; a static check runs beside it only while the load can be read, and it cannot`;
  if (load + beside + resources.cpu < limit) return undefined;
  return `${held}; a static check runs beside it only while the one-minute load stays under the quiet limit ${String(limit)}: load ${load.toFixed(2)}${beside > 0 ? ` plus ${String(beside)} CPU just admitted` : ''} plus its ${String(resources.cpu)} CPU reaches it`;
}

/**
 * What a running quiet phase means for the jobs waiting: an exclusive one, like
 * a host-wide block, stops `everyone`; a shared one is `held`, which only static
 * checks pass.
 */
function quietHold(
  active: readonly JobRecord[],
  context: AdmissionContext,
  now: number
): { everyone?: string; held?: string } {
  if (context.blocked !== undefined) return { everyone: context.blocked };
  const holder = active.find(phaseQuiet);
  if (holder === undefined) return {};
  const held = `Waiting for the quiet phase of ${quietPhaseText(holder, now)}`;
  return quietMode(holder) === 'exclusive' ? { everyone: held } : { held };
}

/**
 * Why a quiet phase cannot start yet, or undefined when it can. An exclusive one
 * waits for every other phase to drain; a shared one only for those that could
 * not run beside it, and for room beside the static checks still running. Then
 * the load has to be under the quiet limit.
 */
function quietStart(
  job: JobRecord,
  running: readonly JobRecord[],
  host: { context: AdmissionContext; used: ResourceVector }
): { blocked: string } | { interrupt: string } | undefined {
  const exclusive = quietMode(job) === 'exclusive';
  const draining = running.filter((other) => exclusive || !joinsQuiet(other));
  const resources = currentResources(job);
  const crowded =
    draining.length === 0 &&
    running.length > 0 &&
    RESOURCE_NAMES.some(
      (name) => host.used[name] + resources[name] > host.context.config.capacity[name]
    );
  if (draining.length > 0 || crowded)
    return {
      blocked: `Draining the host for this quiet phase: waiting for ${(draining.length > 0 ? draining : running).map((other) => `job ${other.id}`).join(', ')}`,
    };
  return loadBlock(job, host.context);
}

/**
 * Atomic phase admission in ticket order, work-conserving: a job that cannot
 * start reserves what it is waiting for and later jobs may pass only if they
 * fit and touch nothing reserved. A job waiting on a lane reserves the lane
 * alone, since CPU cannot free up for it before the lane does; once only CPU or
 * memory blocks it, those are reserved and it starts as soon as they drain, so
 * a stream of small jobs cannot starve it. A quiet waiter drains the host, then
 * waits for the load from outside the coordinator to fall below the quiet limit;
 * nothing behind it starts meanwhile. Each phase queues with a fresh ticket, so
 * between two quiet steps of one job the jobs that waited during the first go
 * ahead of the second. A shared quiet phase lets static checks start beside it
 * while the load stays under the limit; an exclusive one lets nothing start.
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
  const now = context.now ?? Date.now();
  const { everyone, held } = quietHold(active, context, now);
  if (everyone !== undefined) {
    blockAll(everyone, waiting);
    return plan;
  }
  // Nothing passes a quiet waiter, so a stream of static checks cannot starve it.
  const blockBehind = (job: JobRecord, index: number): AdmissionPlan => {
    blockAll(
      `Waiting for the quiet phase of ${quietPhaseText(job, now)}`,
      waiting.slice(index + 1)
    );
    return plan;
  };
  const reserved = new Set<ResourceName>();
  // CPU this pass admits, which the load reading does not show yet.
  let beside = 0;
  for (const [index, job] of waiting.entries()) {
    if (held !== undefined && !joinsQuiet(job)) {
      plan.blocked.set(job.id, `${held}; only a static check runs beside it`);
      if (phaseQuiet(job)) return blockBehind(job, index);
      continue;
    }
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
      const outcome = quietStart(job, [...active, ...plan.admit.map((entry) => entry.job)], {
        context,
        used,
      });
      if (outcome === undefined) plan.admit.push({ job, ...(slot === undefined ? {} : { slot }) });
      else if ('interrupt' in outcome) plan.interrupt.set(job, outcome.interrupt);
      else plan.blocked.set(job.id, outcome.blocked);
      return blockBehind(job, index);
    }
    const resources = currentResources(job);
    const crowded = besideBlock(held, resources, beside, context);
    if (crowded !== undefined) {
      plan.blocked.set(job.id, crowded);
      continue;
    }
    // Nothing to reserve: no job admitted now could wake the display, and only windows wait for it.
    if (resources.display > 0 && context.displayDown !== undefined) {
      plan.blocked.set(job.id, `display: ${context.displayDown}`);
      continue;
    }
    const waitingFor = resourceBlock(resources, used, context.config.capacity, reserved);
    if (waitingFor !== undefined) {
      plan.blocked.set(
        job.id,
        displayWait(resources, used, context.config.capacity, [
          ...active,
          ...plan.admit.map((entry) => entry.job),
        ]) ?? waitingFor
      );
      continue;
    }
    plan.admit.push({ job, ...(slot === undefined ? {} : { slot }) });
    if (slot !== undefined) occupied.set(slot, job.id);
    for (const name of RESOURCE_NAMES) used[name] += resources[name];
    beside += resources.cpu;
  }
  return plan;
}

/** Whether a step reads the generated build configuration a slot's preparation writes. */
export const needsBuildDerived = (step: JobStep | undefined): boolean =>
  step?.command === 'package' || stepTraits(step).builds;
