// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { availableParallelism, totalmem } from 'node:os';

import type { ProcessBirth } from '../../utils/process-birth.js';
import {
  adapterJobs,
  adapterOptionValues,
  adapterPositionals,
  validateAdapterArguments,
} from './adapter-arguments.js';
import { assertFullCheckArguments } from './check-arguments.js';
import { assertKeptProfileShape } from './kept-profile.js';
import { assertStepDeclaration, escapesSlot } from './step-environment.js';
import { stepTraits } from './step-traits.js';
import { requestedTestRepeats } from './test-repeats.js';

/** Portable job requests and local execution ownership, independent of transport. */
export const ADAPTER_COMMANDS = [
  'check',
  'build',
  'test',
  'typecheck',
  'lint',
  'verify',
  'status',
  'furnace',
  'run',
  'package',
  'qualify-native',
] as const;
export type AdapterCommand = (typeof ADAPTER_COMMANDS)[number];
export const RESOURCE_NAMES = ['cpu', 'memory', 'build', 'browser', 'display'] as const;
export type ResourceName = (typeof RESOURCE_NAMES)[number];
/** `cpu` counts schedulable units and `memory` counts GiB; the rest are lanes. */
export type ResourceVector = Record<ResourceName, number>;
export type JobState =
  'queued' | 'running' | 'sealing' | 'passed' | 'failed' | 'cancelled' | 'interrupted';
export type ProcessIdentity = ProcessBirth;
export interface JobStep {
  resources?: ResourceVector;
  quiet?: boolean;
  command: AdapterCommand;
  args: string[];
  /** The harness roster: exactly the files that have to start and complete. */
  expected?: { files: string[] };
  controlAssertions?: string[];
  /** Cancels the step when it runs longer; a default applies by adapter. */
  deadlineSeconds?: number;
  /** Validated environment for a test or run. Part of what the step proved. */
  env?: Record<string, string>;
  /** A private `MOZ_UPLOAD_DIR` inside this job's artifacts, for captures and censuses. */
  uploadDir?: boolean;
  /** Holds a display and idle assertion for this phase. Defaults on for a step with a window. */
  keepAwake?: boolean;
  /** Keeps this headed step's own browser frontmost, and reads red if it could not. */
  holdFront?: boolean;
  /** Runs the browser under this fixed `taskpolicy` clamp. Part of what the step proved. */
  throttle?: import('./step-environment.js').StepThrottle;
  /** Judges the harness's output in the same phase. Its command is part of what the step proved. */
  validate?: import('./step-validate.js').StepValidator;
  /**
   * A run a person drives: its window is theirs, so its exit proves nothing, and
   * no job holding one is ever evidence. Only a job's last step can be one.
   */
  interactive?: boolean;
  /** An interactive run's kept profile: an absolute directory outside every slot, the namespace and tracked source. */
  profile?: string;
  /** What progress calls the step, such as prove's obligation ID. Display only: nothing proved reads it. */
  label?: string;
}
export interface JobRequest {
  schemaVersion: 1;
  /** Idempotency key; equal keys require byte-equivalent requests. */
  key: string;
  /** The named slot. Absent, the scheduler assigns one. */
  slot?: string;
  sourceId: string;
  steps: JobStep[];
  build?: { mode: 'dev' | 'debug' | 'release'; brand: string };
  /** An upper bound on the vectors steps state. A derived vector answers to capacity alone. */
  resources?: ResourceVector;
  quiet: boolean;
  /** Read every tool byte at sealing rather than comparing stat signatures. */
  finalGate?: boolean;
  /**
   * Go on past a red step, so every step gets a verdict in one job. A step that
   * needs what a red step did not leave (a package after a red build) is blocked,
   * not run. The job still ends failed.
   */
  continueOnFailure?: boolean;
}
/** A step of a job that went on past a red one: red itself, or blocked by an earlier step. */
export interface StepVerdict {
  step: number;
  state: 'red' | 'blocked';
  reason: string;
  /** For a red step: its {@link StepEvidence.hostLoadPeak}. */
  hostLoadPeak?: StepLoadPeak;
  /** For a red step: its {@link StepEvidence.hostState}. */
  hostState?: StepHostState;
  /** For a red step: its {@link StepEvidence.hostDisk}. */
  hostDisk?: StepDiskLow;
}
/** Who cancelled a job, as the cancelling client reported itself. */
export interface CancelAttribution {
  /** The cancelling client's owner label. */
  owner: string;
  cwd: string;
  pid: number;
  at: string;
}

export interface JobRecord {
  schemaVersion: 1;
  id: string;
  /** Free-text label for display; it grants nothing. */
  owner: string;
  request: JobRequest;
  state: JobState;
  epoch: number;
  submittedAt: string;
  updatedAt: string;
  cancellationRequested: boolean;
  /** Who asked for the cancellation, when a client did: the first request stands. */
  cancelledBy?: CancelAttribution;
  /** The slot this job runs on: the named one, or the one the scheduler assigned. */
  slot?: string;
  /** The source's pristine pin, which limits the slots it can run on. */
  pin?: string;
  /** The compiled inputs a slot's anchor has to match for this job to skip a full build. */
  compiledDigest?: string;
  /** Each step's admitted vector, resolved at submission. */
  stepResources?: ResourceVector[];
  phase?: {
    index: number;
    active: boolean;
    ticket: number;
    nonce?: string;
    deadlineAt?: string;
    /** When this phase was admitted. Display only. */
    startedAt?: string;
  };
  /** When the job's first phase was admitted. Display only. */
  startedAt?: string;
  process?: ProcessIdentity;
  executionToken?: string;
  projectToolsDigest?: string;
  executorToolsDigest?: string;
  gitExecutable?: string;
  gitExecPath?: string;
  qualityToolsDigest?: string;
  nativeToolsDigest?: string;
  toolIdentityTimings?: Record<string, number>;
  exitCode?: number;
  reason?: string;
  /** The last step's {@link StepEvidence.hostLoadPeak}, recorded when the job ends red. */
  hostLoadPeak?: StepLoadPeak;
  /** The last step's {@link StepEvidence.hostState}, recorded when the job ends red or interrupted. */
  hostState?: StepHostState;
  /** The last step's {@link StepEvidence.hostDisk}, recorded when the job ends red or interrupted. */
  hostDisk?: StepDiskLow;
  /** It ended without its step having started, so this says nothing about that step. */
  refused?: boolean;
  /** Self-detached descendants that outlived a phase with no foothold in the slot. */
  detached?: Array<{ pid: number; group: number; command?: string; start?: string }>;
  /** Where each step with an output directory wrote it. Removed with the job's other artifacts. */
  outputs?: Array<{ step: number; path: string }>;
  receipt?: SealedReceipt;
  /** A failed job's audited evidence for the steps that passed. */
  partialReceipt?: SealedReceipt;
  /** Under `continueOnFailure`: each step that went red or was blocked, in order. */
  stepVerdicts?: StepVerdict[];
}
/** A job as a client sees it: no execution token, and why it is not running yet. */
export type JobView = Omit<JobRecord, 'executionToken'> & {
  blockedBy?: string;
  /** Where a job that is still under way stands. */
  progress?: import('./job-progress.js').JobProgress;
};
export interface SealedReceipt {
  schemaVersion: 1;
  jobId: string;
  sourceId: string;
  slotGeneration: number;
  runtimeIdentity: import('./slot-types.js').PhaseRuntimeIdentity;
  successfulBuildGeneration: number;
  buildBaselineDigest?: string;
  ledgerDigest: string;
  runtimeDigest: string;
  toolsDigest: string;
  projectToolsDigest: string;
  qualityToolsDigest: string;
  nativeToolsDigest?: string;
  toolIdentityTimings?: Record<string, number>;
  configDigest: string;
  environmentDigest: string;
  resources: ResourceVector;
  quiet: boolean;
  steps: StepEvidence[];
  sealedAt: string;
}
export interface CoordinatorConfig {
  schemaVersion: 1;
  capacity: ResourceVector;
  maxSlots: number;
  idleMs: number;
  legacyExcluded: boolean;
  /** Git common directories (or plain roots) whose direct builds and browsers need a job. */
  projects: string[];
  /** The supervisor's Node and environment, fixed at initialization rather than by a first caller. */
  runtime: { node: string; environment: Record<string, string> };
  /** This host's directory of release secrets. It never enters captured source or a digest. */
  releaseSecrets?: string;
  /** The one-minute load a quiet phase waits to fall below. Absent, {@link quietLoadLimit} derives it. */
  quietLoad?: number;
  /** Free GiB below which a step's red is annotated as possibly disk pressure; at least 3% of the volume applies as well. Absent, {@link DEFAULT_DISK_LOW_GIB}. */
  diskLowGib?: number;
  /** Most GiB job artifacts may occupy before the oldest of finished jobs go. Absent, {@link DEFAULT_ARTIFACT_MAX_GIB}. */
  artifactMaxGib?: number;
  /** Days after which a finished job's artifacts go. Absent, {@link DEFAULT_ARTIFACT_MAX_AGE_DAYS}. */
  artifactMaxAgeDays?: number;
  /**
   * Waiting jobs per slot holding the build they need at which the supervisor
   * replicates that build into an idle slot; 0 turns replication off. Absent,
   * {@link DEFAULT_REPLICATE_DEPTH}.
   */
  replicateDepth?: number;
  /**
   * Steps read a steady host (network up, lid open, display awake, no input)
   * instead of this one. Only a test fixture's `initializeCoordinator` sets it;
   * no command, flag or environment variable does.
   */
  steadyHost?: true;
}
export const DEFAULT_MAX_SLOTS = 3;
export const DEFAULT_DISK_LOW_GIB = 10;
export const DEFAULT_ARTIFACT_MAX_GIB = 10;
export const DEFAULT_ARTIFACT_MAX_AGE_DAYS = 14;
export const DEFAULT_REPLICATE_DEPTH = 2;
/** The newest finished jobs of each owner whose artifacts are never pruned. */
export const ARTIFACTS_KEPT_PER_OWNER = 3;

/** The load at which the host is too busy for a quiet phase: by default, one runnable thread per CPU. */
export const quietLoadLimit = (config: Pick<CoordinatorConfig, 'capacity' | 'quietLoad'>): number =>
  config.quietLoad ?? config.capacity.cpu;
const GIB = 1024 ** 3;

/** The host's own capacity: every schedulable CPU and 80% of physical memory. */
export function hostCapacity(): ResourceVector {
  return {
    cpu: availableParallelism(),
    memory: Math.max(1, Math.floor((totalmem() * 0.8) / GIB)),
    build: 1,
    browser: 1,
    display: 1,
  };
}

export const terminal = (state: JobState): boolean =>
  ['passed', 'failed', 'cancelled', 'interrupted'].includes(state);

/** The slot a job runs on, or undefined until the scheduler assigns one. */
export const jobSlot = (job: JobRecord): string | undefined => job.slot ?? job.request.slot;

/** A check's CPU: a quarter of the host, so it runs beside a build, or what its steps declare if less. */
function checkCpu(capacity: ResourceVector, footprints: CheckFootprints): number {
  const quarter = Math.max(2, Math.ceil(capacity.cpu / 4));
  return Math.min(quarter, Math.max(2, footprints.cpu));
}

/** What a check's captured project steps declare they need, on top of its built-ins. */
export interface CheckFootprints {
  cpu: number;
  memory: number;
}

/** The step's vector before any caller claim: an honest footprint, never above capacity. */
export function derivedResources(
  step: JobStep,
  capacity: ResourceVector,
  projectBuildJobs?: number,
  footprints?: CheckFootprints
): ResourceVector {
  const traits = stepTraits(step);
  const explicit = adapterJobs(step);
  const buildCpu = Math.min(
    Math.max(1, Math.floor(capacity.cpu * 0.75)),
    projectBuildJobs ?? Number.MAX_SAFE_INTEGER
  );
  const heavy =
    step.command === 'build' || traits.preTestBuild || traits.control || traits.releaseBuild;
  const wanted = {
    cpu:
      explicit ??
      (heavy
        ? buildCpu
        : step.command === 'check' && footprints
          ? checkCpu(capacity, footprints)
          : Math.max(2, step.validate?.footprint?.cpu ?? 0)),
    memory: heavy
      ? Math.ceil(capacity.memory / 2)
      : traits.browser
        ? Math.max(4, step.validate?.footprint?.memory ?? 0)
        : Math.max(2, footprints?.memory ?? 0),
    build: traits.buildLane ? 1 : 0,
    browser: traits.browser ? 1 : 0,
    display: traits.display ? 1 : 0,
  };
  return {
    ...wanted,
    cpu: Math.max(1, Math.min(wanted.cpu, capacity.cpu)),
    memory: Math.max(1, Math.min(wanted.memory, capacity.memory)),
  };
}

/** The floor below which a caller's explicit vector understates the adapter. */
export function minimumResources(step: JobStep | undefined): ResourceVector {
  const traits = stepTraits(step);
  return {
    cpu: 1,
    memory: 1,
    build: traits.buildLane ? 1 : 0,
    browser: traits.browser ? 1 : 0,
    display: traits.display ? 1 : 0,
  };
}

/**
 * Fills what a request can state by default, so a hand-written one is a few
 * fields. The result is what is validated, journaled and compared by key.
 *
 * @param value - The parsed request
 * @param snapshotId - The frozen snapshot it runs against
 */
export function normalizeRequest(value: unknown, snapshotId: string): JobRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Job request must be a JSON object');
  const r = value as Partial<Omit<JobRequest, 'schemaVersion'>> & { schemaVersion?: unknown };
  if (r.sourceId !== undefined && r.sourceId !== snapshotId)
    throw new Error(`Job request names source ${r.sourceId}, but the snapshot is ${snapshotId}`);
  if (r.schemaVersion !== undefined && r.schemaVersion !== 1)
    throw new Error('Job request schemaVersion must be 1');
  const steps: unknown = r.steps;
  const body = {
    ...r,
    schemaVersion: 1 as const,
    sourceId: snapshotId,
    quiet: r.quiet ?? false,
    steps: (Array.isArray(steps) ? steps.map(normalizeStep) : steps) as JobStep[],
  };
  const { key, ...identity } = body;
  return {
    ...body,
    key:
      key ??
      `auto-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 40)}`,
  };
}

/** A key the client derived from content: a rerun after a red is new work, not a duplicate. */
export const derivedKey = (key: string): boolean => /^auto-[a-f0-9]{40}$/.test(key);

function normalizeStep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const step = value as JobStep;
  if (step.command !== 'test' || !Array.isArray(step.args) || stepTraits(step).buildOnly)
    return step;
  if (step.expected !== undefined) return step;
  const files = adapterPositionals(step).filter((arg) => /\.[A-Za-z0-9]+$/.test(arg));
  return files.length === 0 ? step : { ...step, expected: { files } };
}

/** Decode untrusted JSON without accepting executable commands or resource widening. */
export function validateRequest(value: unknown): asserts value is JobRequest {
  if (value === null || typeof value !== 'object') throw new Error('Invalid job request');
  const r = value as { [K in keyof JobRequest]?: unknown };
  if (r.schemaVersion !== 1) throw new Error('Job request schemaVersion must be 1');
  if (typeof r.key !== 'string' || !/^[\w.-]{1,120}$/.test(r.key))
    throw new Error(
      'Job request key must be 1 to 120 letters, digits, dots, dashes or underscores'
    );
  if (r.slot !== undefined && (typeof r.slot !== 'string' || !/^[\w.-]{1,80}$/.test(r.slot)))
    throw new Error('Job request slot must be a slot name, or absent to let the scheduler choose');
  if (typeof r.sourceId !== 'string' || !/^[a-f0-9]{32,128}$/.test(r.sourceId))
    throw new Error('Job request sourceId must be the snapshot id');
  if (typeof r.quiet !== 'boolean') throw new Error('Job request quiet must be a boolean');
  if (!Array.isArray(r.steps) || r.steps.length === 0 || r.steps.length > 100)
    throw new Error('Job request steps must list 1 to 100 adapter steps');
  if (r.finalGate !== undefined && typeof r.finalGate !== 'boolean')
    throw new Error('Job request finalGate must be a boolean');
  if (r.continueOnFailure !== undefined && typeof r.continueOnFailure !== 'boolean')
    throw new Error('Job request continueOnFailure must be a boolean');
  validateSteps(r.steps as unknown[]);
  if (r.resources !== undefined) validateResources(r.resources);
}

/** Every resource dimension is explicit and finite, including static CPU and memory. */
function validateResources(value: unknown): asserts value is ResourceVector {
  if (value === null || typeof value !== 'object') throw new Error('Missing resources');
  const r = value as Record<string, unknown>;
  const names: readonly string[] = RESOURCE_NAMES;
  if (Object.keys(r).some((name) => !names.includes(name)))
    throw new Error('Unknown resource dimension');
  for (const name of names)
    if (!Number.isSafeInteger(r[name]) || Number(r[name]) < 0)
      throw new Error(`Invalid resource ${name}`);
  if (r['cpu'] === 0 || r['memory'] === 0) throw new Error('Jobs must account for CPU and memory');
}

/** A step's highest one-minute load average, rounded to hundredths, and when in the step. */
export interface StepLoadPeak {
  load: number;
  atSeconds: number;
}
/**
 * Host conditions that changed under a test or run step, each as the seconds
 * after the step's start it was first seen. Lid, display and network count only
 * when an earlier sample saw them fine; input counts when it came after the start.
 */
export interface StepHostState {
  /** The lid closed. */
  lidClosed?: number;
  /** No display stayed active: asleep, or the lid closed with no other display. */
  displaySlept?: number;
  /** No interface other than loopback kept a routable address. */
  networkLost?: number;
  /** Keyboard or pointer input reached the host during a step with a window. */
  input?: number;
  /** Another application was in front of the step's own browser, so a capture then shows something else. */
  foregroundLost?: number;
}
/**
 * The least free space a step saw on a volume it works on, when that fell below
 * the low-disk threshold: bytes free, seconds after the step's start, and which volume.
 */
export interface StepDiskLow {
  freeBytes: number;
  atSeconds: number;
  /** The coordinator namespace's volume, or the slot's when that is a different one. */
  volume: 'namespace' | 'slot';
}
export interface StepEvidence {
  runtimeBefore: import('./slot-types.js').PhaseRuntimeIdentity;
  runtimeAfter?: import('./slot-types.js').PhaseRuntimeIdentity;
  sourceGeneration: number;
  successfulBuildGeneration: number;
  derivedDigest: string;
  index: number;
  command: AdapterCommand;
  /** The adapter arguments the request named, so a receipt says what actually ran. */
  args: string[];
  /** The environment the request declared, as declared. */
  env?: Record<string, string>;
  /** The `taskpolicy` clamp the browser ran under. */
  throttle?: import('./step-environment.js').StepThrottle;
  /** How holding the browser in front went. */
  front?: import('./hold-front.js').FrontReport;
  /** The validator that exited clean after the harness, as declared. */
  validated?: string[];
  /**
   * The highest one-minute load average seen while the step ran, and how many
   * seconds after its start. Context for reading a red; no identity or proof reads it.
   */
  hostLoadPeak?: StepLoadPeak;
  /** What changed on the host while the step ran. Context for reading a red; no identity or proof reads it. */
  hostState?: StepHostState;
  /** The least free disk space the step saw, when below the low-disk threshold. Context for reading a red; no identity or proof reads it. */
  hostDisk?: StepDiskLow;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  /** The roster every repeat started and completed; empty for non-test adapters. */
  selectedFiles: string[];
  /** Actual complete per-repeat dispatch ordinals; omitted by non-test adapters. */
  completedRuns?: number[];
  resultDigest?: string;
  check?: import('./check-types.js').FullCheckEvidence;
  control?: 'caught';
  controlProof?: {
    expectedAssertions: string[];
    /** The labels the reds carried: an xpcshell red's task, a mochitest red's assertion. */
    actualAssertions: string[];
    /** An xpcshell red's assertion text, which a label may match instead of its task. */
    actualMessages?: string[];
    mutations: import('../test-results-document.js').TestControlEvidence[];
  };
}
export interface ExecutionReport {
  schemaVersion: 1;
  jobId: string;
  toolsBefore: string;
  toolsAfter: string;
  environmentDigest: string;
  steps: StepEvidence[];
}

/** Check frozen adapter paths, rosters and control expectations before queuing. */
function validateSteps(raw: readonly unknown[]): void {
  const steps: JobStep[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') throw new Error('Unsupported job adapter');
    const step = entry as JobStep;
    steps.push(step);
    const args: unknown = step.args;
    if (
      !ADAPTER_COMMANDS.includes(step.command) ||
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    )
      throw new Error(`Unsupported job adapter or arguments: ${step.command}`);
    validateRunProfile(step);
    validateAdapterArguments(step);
    assertStepDeclaration(step);
    if (step.command === 'test') requestedTestRepeats(step.args);
    if (step.command === 'check') assertFullCheckArguments(step.args, step.resources?.cpu);
    if (step.resources !== undefined) validateResources(step.resources);
    if (
      step.label !== undefined &&
      (typeof step.label !== 'string' || !/^[^\p{Cc}]{1,120}$/u.test(step.label))
    )
      throw new Error('Step label must be 1 to 120 characters with no control characters');
    if (
      step.deadlineSeconds !== undefined &&
      (!Number.isSafeInteger(step.deadlineSeconds) || step.deadlineSeconds < 1)
    )
      throw new Error('Step deadlineSeconds must be a positive whole number');
  }
  validateInteractive(steps);
  for (const step of steps) {
    if (step.args.some(escapesSlot))
      throw new Error('Job inputs and outputs must be relative to the frozen slot');
    if (step.command === 'test' && !stepTraits(step).buildOnly) {
      if (!step.expected || !Array.isArray(step.expected.files) || step.expected.files.length === 0)
        throw new Error(
          'Test jobs require a file roster: name test files as arguments, or set expected.files'
        );
    }
    if (step.args.some((arg) => arg === '--results' || arg.startsWith('--results=')))
      throw new Error('The executor owns unique results paths');
    if (stepTraits(step).control && !step.controlAssertions?.length)
      throw new Error('A control job requires expected failing assertion labels');
  }
}

/**
 * Every run starts from a fresh profile: a kept one would carry one run's state
 * into the next one's verdict. The one exception is an interactive run's typed
 * `profile`, which can never be evidence. Browser arguments never name a profile.
 */
function validateRunProfile(step: JobStep): void {
  // Untrusted JSON: anything but a literal true is refused.
  const interactive: unknown = step.interactive;
  if (interactive !== undefined && (interactive !== true || step.command !== 'run'))
    throw new Error('Step interactive applies to a run step, and is true when set');
  if (step.profile !== undefined) {
    if (step.interactive !== true)
      throw new Error(
        'Only an interactive run keeps a profile: fireforge job run --run --profile <dir>'
      );
    assertKeptProfileShape(step.profile);
  }
  if (step.command !== 'run') return;
  if (step.args.some((arg) => /^(?:-P|-profile|--profile-manager|-ProfileManager)/.test(arg)))
    throw new Error('Browser profile passthrough is not admitted');
  if (adapterOptionValues(step, '--profile').length > 0)
    throw new Error(
      'A job run always starts from a fresh profile; drop --profile. Only an interactive run keeps one: fireforge job run --run --profile <dir>'
    );
}

/** One person drives one window: an interactive run is a job's last step, and its only one. */
function validateInteractive(steps: readonly JobStep[]): void {
  const at = steps.findIndex((step) => step.interactive === true);
  if (at !== -1 && at !== steps.length - 1)
    throw new Error('An interactive run is the last step of its job, and its only interactive one');
}
