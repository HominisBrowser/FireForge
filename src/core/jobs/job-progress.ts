// SPDX-License-Identifier: EUPL-1.2
import { type JobRecord, type JobStep, terminal } from './schema.js';

/** How one finished step of a job that is still under way ended. */
export interface StepResult {
  /** From 0, as in `job logs --step`. */
  step: number;
  label: string;
  state: 'passed' | 'red' | 'blocked';
}

/** Where a job that is still under way stands, derived from its record when it is read. */
export interface JobProgress {
  /** The current step, from 0 as in `job logs --step`; equal to `steps` while the job seals. */
  step: number;
  /** How many steps the job has. */
  steps: number;
  /** The current step's label, or `sealing`. */
  label: string;
  /** The current step holds the host now, rather than waiting to be admitted. */
  running: boolean;
  /** When the current step was admitted, while it runs. */
  stepStartedAt?: string;
  /** Seconds since then. */
  stepSeconds?: number;
  /** When the job's first step was admitted. */
  startedAt?: string;
  /** Seconds since then. */
  elapsedSeconds?: number;
  /** Every step before the current one, in order. */
  results: StepResult[];
}

const LABEL_LIMIT = 60;

/** Marks a job's current phase admitted, stamping when it and the job started. */
export function admitPhase(draft: JobRecord, at = new Date().toISOString()): void {
  if (draft.phase !== undefined) {
    draft.phase.active = true;
    draft.phase.startedAt = at;
  }
  draft.startedAt ??= at;
}

/**
 * What a step is called where a person reads progress: its `label` when the
 * request gave one (prove gives each step its obligation ID), else its command
 * and arguments, a test's files counted rather than listed.
 */
export function stepLabel(step: JobStep | undefined): string {
  if (step === undefined) return 'sealing';
  if (step.label !== undefined) return step.label;
  const files = step.command === 'test' ? (step.expected?.files.length ?? 0) : 0;
  const text =
    files > 0
      ? `test (${String(files)} file${files === 1 ? '' : 's'})`
      : [step.command, ...step.args].join(' ');
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 1)}…` : text;
}

/** A duration as a person reads it: `45s`, `12m05s`, `1h04m`. */
export function formatSeconds(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number): string => String(value).padStart(2, '0');
  if (whole < 60) return `${String(whole)}s`;
  if (whole < 3600) return `${String(Math.floor(whole / 60))}m${pad(whole % 60)}s`;
  return `${String(Math.floor(whole / 3600))}h${pad(Math.floor((whole % 3600) / 60))}m`;
}

const secondsSince = (at: string | undefined, now: number): number | undefined => {
  const parsed = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(parsed) ? undefined : Math.max(0, Math.round((now - parsed) / 1000));
};

/**
 * Each step before the current one: red or blocked as its verdict says, passed
 * otherwise, since a job that is still under way went past it.
 */
function stepResults(job: JobRecord): StepResult[] {
  const verdicts = new Map((job.stepVerdicts ?? []).map((verdict) => [verdict.step, verdict]));
  const index = Math.min(job.phase?.index ?? 0, job.request.steps.length);
  return job.request.steps.slice(0, index).map((step, at) => ({
    step: at,
    label: stepLabel(step),
    state: verdicts.get(at)?.state ?? 'passed',
  }));
}

/** Where a job stands, or undefined once it has ended or before it has a phase. */
export function jobProgress(job: JobRecord, now = Date.now()): JobProgress | undefined {
  if (terminal(job.state) || job.phase === undefined) return undefined;
  const { phase } = job;
  const steps = job.request.steps.length;
  const running = phase.active && (job.state === 'running' || job.state === 'sealing');
  const stepSeconds = running ? secondsSince(phase.startedAt, now) : undefined;
  const elapsedSeconds = secondsSince(job.startedAt, now);
  return {
    step: Math.min(phase.index, steps),
    steps,
    label: stepLabel(job.request.steps[phase.index]),
    running,
    ...(stepSeconds === undefined ? {} : { stepStartedAt: phase.startedAt, stepSeconds }),
    ...(elapsedSeconds === undefined ? {} : { startedAt: job.startedAt, elapsedSeconds }),
    results: stepResults(job),
  };
}

/** One line of progress: `step 6/11 lane:hominis running 12m05s, 1h04m in; passed 5 red 0 blocked 0`. */
export function progressLine(progress: JobProgress): string {
  const count = (state: StepResult['state']): number =>
    progress.results.filter((result) => result.state === state).length;
  const position =
    progress.step >= progress.steps
      ? `sealing ${String(progress.steps)}/${String(progress.steps)}`
      : `step ${String(progress.step + 1)}/${String(progress.steps)} ${progress.label}`;
  return [
    position,
    progress.running
      ? `running${progress.stepSeconds === undefined ? '' : ` ${formatSeconds(progress.stepSeconds)}`}`
      : 'waiting',
    ...(progress.elapsedSeconds === undefined
      ? []
      : [`${formatSeconds(progress.elapsedSeconds)} in`]),
    ...(progress.results.length === 0
      ? []
      : [
          `passed ${String(count('passed'))} red ${String(count('red'))} blocked ${String(count('blocked'))}`,
        ]),
  ].join(', ');
}

/** The quiet phase a job holds or waits for, as a blocked reason names it. */
export function quietPhaseText(job: JobRecord, now = Date.now()): string {
  const index = job.phase?.index ?? 0;
  const position = `step ${String(index + 1)}/${String(job.request.steps.length)} ${stepLabel(job.request.steps[index])}`;
  const active = job.phase?.active === true;
  const held = active ? secondsSince(job.phase?.startedAt, now) : undefined;
  const state = !active
    ? ', not started'
    : held === undefined
      ? ''
      : `, holding the host for ${formatSeconds(held)}`;
  return `job ${job.id} (${position}${state})`;
}

/** Each finished step by name: `check passed, build passed, lane:unit red`. */
export const resultsLine = (progress: JobProgress): string =>
  progress.results.map((result) => `${result.label} ${result.state}`).join(', ');
