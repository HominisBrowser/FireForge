// SPDX-License-Identifier: EUPL-1.2
/** The evidence for a source: what each finished job's record says its steps did. */
import { digest } from '../authored/git.js';
import type { JobRecord, JobStep, SealedReceipt, StepEvidence } from '../jobs/schema.js';
import { terminal } from '../jobs/schema.js';
import type { BuildIdentity } from '../jobs/slot-types.js';
import { readJournal } from '../jobs/store.js';
import { stepFingerprint } from './plan.js';

/** What a tool identity holds, each part digested on its own so a kind can bind only what reaches it. */
export interface ToolIdentity {
  executor: string | undefined;
  project: string;
  quality: string;
  environment: string;
}

/** One step's result in one job, under the key evidence is looked up by. */
export interface EvidenceRow {
  fingerprint: string;
  status: 'passed' | 'red';
  job: string;
  at: string;
  reason?: string;
  tools?: ToolIdentity;
  build?: BuildIdentity;
  finalGate: boolean;
  evidence?: StepEvidence;
  /** The step's private output directory, when it has one. */
  output?: string;
  /** From the carried source, so it counts only for an obligation the plan carries. */
  carried?: true;
}

/** A step a job did not run because an earlier step of it left nothing it could run on. */
export interface BlockedRow {
  job: string;
  at: string;
  reason: string;
}

export interface EvidenceStore {
  rows: EvidenceRow[];
  /** Fingerprints of steps a job blocked, with the newest such job. No verdict on the step. */
  blocked: Map<string, BlockedRow>;
  /** Fingerprints of steps a live job holds, and those jobs. */
  live: Map<string, string>;
  /** Jobs that failed after their steps passed, which leaves them no evidence. */
  failures: Array<{ job: string; reason: string }>;
  /** Every finished job on this source: what makes a repeat of a request new work. */
  finished: number;
}

/** The source fixes the configuration and a build's identity fixes the recipe, so neither is here. */
const toolIdentity = (job: JobRecord, receipt: SealedReceipt): ToolIdentity => ({
  executor: job.executorToolsDigest,
  project: receipt.projectToolsDigest,
  quality: receipt.qualityToolsDigest,
  environment: receipt.environmentDigest,
});

/**
 * The steps a job went red on: each one a job that went on past reds recorded,
 * and the step a failed job stopped on. A refused job never started that step, so it adds none.
 */
function redSteps(job: JobRecord): Array<{ index: number; reason?: string }> {
  const recorded = (job.stepVerdicts ?? [])
    .filter((verdict) => verdict.state === 'red')
    .map((verdict) => ({ index: verdict.step, reason: verdict.reason }));
  const index = job.phase?.index ?? 0;
  const stopped =
    job.state === 'failed' &&
    job.refused !== true &&
    index < job.request.steps.length &&
    !(job.stepVerdicts ?? []).some((verdict) => verdict.step === index)
      ? [{ index, ...(job.reason === undefined ? {} : { reason: job.reason }) }]
      : [];
  return [...recorded, ...stopped];
}

const fingerprintOf = (job: JobRecord, step: JobStep): string =>
  stepFingerprint({ ...step, quiet: step.quiet ?? job.request.quiet });

/** What one job contributes. A receipt counts only when the journal says the job reached it. */
function jobRows(job: JobRecord): EvidenceRow[] {
  const receipt =
    job.state === 'passed' ? job.receipt : job.state === 'failed' ? job.partialReceipt : undefined;
  const finalGate = job.request.finalGate === true;
  const outputOf = (index: number): Pick<EvidenceRow, 'output'> => {
    const path = job.outputs?.find((entry) => entry.step === index)?.path;
    return path === undefined ? {} : { output: path };
  };
  const rows: EvidenceRow[] = [];
  for (const evidence of receipt?.steps ?? []) {
    const step = job.request.steps[evidence.index];
    if (
      receipt === undefined ||
      step === undefined ||
      evidence.exitCode !== 0 ||
      evidence.command !== step.command ||
      digest(evidence.args) !== digest(step.args) ||
      digest(evidence.env ?? {}) !== digest(step.env ?? {}) ||
      digest(evidence.validated ?? []) !== digest(step.validate?.command ?? []) ||
      evidence.runtimeAfter?.sourceGeneration !== receipt.slotGeneration
    )
      continue;
    rows.push({
      fingerprint: stepFingerprint({ ...step, quiet: step.quiet ?? job.request.quiet }),
      status: 'passed',
      job: job.id,
      at: evidence.finishedAt,
      tools: toolIdentity(job, receipt),
      ...(evidence.runtimeAfter.build === undefined ? {} : { build: evidence.runtimeAfter.build }),
      finalGate,
      evidence,
      ...outputOf(evidence.index),
    });
  }
  for (const red of redSteps(job)) {
    const step = job.request.steps[red.index];
    if (step === undefined) continue;
    rows.push({
      fingerprint: fingerprintOf(job, step),
      status: 'red',
      job: job.id,
      at: job.updatedAt,
      ...(red.reason === undefined ? {} : { reason: red.reason }),
      finalGate,
      ...outputOf(red.index),
    });
  }
  return rows;
}

/**
 * A job a person drove: its interactive run's window was theirs, and it may have
 * kept a profile from an earlier session. Nothing it did, before or during that
 * run, is evidence, and while it lives it holds no obligation's place.
 */
const evidential = (job: Pick<JobRecord, 'request'>): boolean =>
  !job.request.steps.some((step) => step.interactive === true);

/**
 * The evidence for a source: a query over the coordinator's durable record, so any
 * job contributes and nothing else can. Reads the journal directly and starts nothing.
 */
export async function readEvidence(namespace: string, source: string): Promise<EvidenceStore> {
  const store: EvidenceStore = {
    rows: [],
    blocked: new Map(),
    live: new Map(),
    failures: [],
    finished: 0,
  };
  for (const job of (await readJournal(namespace)).values()) {
    if (job.request.sourceId !== source || !evidential(job)) continue;
    if (!terminal(job.state)) {
      for (const step of job.request.steps) store.live.set(fingerprintOf(job, step), job.id);
      continue;
    }
    store.finished += 1;
    store.rows.push(...jobRows(job));
    for (const verdict of job.stepVerdicts ?? []) {
      const step = job.request.steps[verdict.step];
      if (verdict.state !== 'blocked' || step === undefined) continue;
      const print = fingerprintOf(job, step);
      const known = store.blocked.get(print);
      if (known === undefined || known.at < job.updatedAt)
        store.blocked.set(print, { job: job.id, at: job.updatedAt, reason: verdict.reason });
    }
    // A job whose steps ran and still failed: sealing did, unless it recorded its reds.
    if (
      job.state === 'failed' &&
      (job.phase?.index ?? 0) >= job.request.steps.length &&
      (job.stepVerdicts ?? []).length === 0
    )
      store.failures.push({ job: job.id, reason: job.reason ?? 'Sealing failed' });
  }
  store.rows.sort((a, b) => a.at.localeCompare(b.at));
  return store;
}
