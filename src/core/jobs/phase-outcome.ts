// SPDX-License-Identifier: EUPL-1.2
import { open } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';

import type { JobRecord, JobState, JobStep, StepHostState, StepLoadPeak } from './schema.js';
import { stepTraits } from './step-traits.js';

/** How a phase ended, as far as its process tree can establish. */
export interface PhaseEnd {
  /** The executor's exit code, or null when it died on a signal or failed to spawn. */
  code: number | null;
  /** The signal that killed it. */
  signal?: string;
  /** Why it could not start. */
  detail?: string;
  /** Why its processes cannot be established as gone, when they cannot. */
  uncertain?: string;
  /** The last thing the step said went wrong, from its log. */
  cause?: string;
}

/** What a phase's end means for the job and the slot. */
export interface PhaseVerdict {
  /** The next phase may run. */
  advance: boolean;
  state: JobState;
  reason?: string;
  /** The slot cannot be trusted until `slot restore`. */
  quarantine?: string;
}

/** The exit codes of a process something stopped from outside: SIGINT, SIGKILL and SIGTERM. */
const SIGNALLED_EXITS: ReadonlySet<number> = new Set([130, 137, 143]);

/** Something stopped the step, which is not the step's verdict on anything. */
function stoppedFromOutside(end: PhaseEnd): boolean {
  return end.signal !== undefined || (end.code !== null && SIGNALLED_EXITS.has(end.code));
}

/**
 * Separates outcome from integrity. A red result, a refusal and a cancel are
 * outcomes: the slot goes back to the pool and the next admission audits it.
 * An executor something killed says nothing about the step, so the job ends
 * interrupted and no red is recorded against what it was running. Only
 * uncertainty about what is still running condemns the slot.
 */
export function judgePhaseEnd(job: JobRecord, end: PhaseEnd): PhaseVerdict {
  const stopped: JobState = job.cancellationRequested
    ? 'cancelled'
    : stoppedFromOutside(end)
      ? 'interrupted'
      : 'failed';
  if (end.uncertain !== undefined) {
    const reason = `Executor group cleanup uncertain: ${end.uncertain}`;
    return { advance: false, state: stopped, reason, quarantine: reason };
  }
  if (job.cancellationRequested)
    return { advance: false, state: 'cancelled', reason: 'Cancelled while running' };
  if (stoppedFromOutside(end))
    return {
      advance: false,
      state: 'interrupted',
      reason: `Executor stopped from outside (${end.signal ?? `exit ${String(end.code)}`})`,
    };
  if (end.code !== 0) {
    const stated = end.detail ?? `Executor exited ${String(end.code)}`;
    return {
      advance: false,
      state: 'failed',
      reason: end.cause === undefined ? stated : `${stated}: ${end.cause}`,
    };
  }
  return { advance: true, state: job.state };
}

/**
 * A quiet step that went red while load from outside passed the quiet limit
 * says nothing about the step, so the job ends interrupted, as one stopped from
 * outside does. Outside load is the step's peak less the CPU the step itself
 * was admitted with, the most its own processes may add. A pass stands.
 */
export function judgeLoadedQuietRed(
  verdict: PhaseVerdict,
  quiet: { peak: StepLoadPeak | undefined; limit: number; cpu: number }
): PhaseVerdict {
  const { peak, limit, cpu } = quiet;
  if (
    verdict.state !== 'failed' ||
    verdict.quarantine !== undefined ||
    peak === undefined ||
    peak.load - cpu < limit
  )
    return verdict;
  return {
    advance: false,
    state: 'interrupted',
    reason: `Host load peaked at ${peak.load.toFixed(2)} ${String(peak.atSeconds)}s in, at or above the quiet limit ${String(limit)} plus the step's own ${String(cpu)} CPU, so this red says nothing about the step: ${verdict.reason ?? 'red'}`,
  };
}

/**
 * A red step under which the host changed what it measures says nothing about
 * the step, so the job ends interrupted, as under outside load. The network
 * going away counts for any step; the lid closing or the display sleeping for a
 * quiet one, whose timing they change; input for one with a window, which it
 * can reach. A pass stands.
 */
export function judgeHostConditionRed(
  verdict: PhaseVerdict,
  host: { state: StepHostState | undefined; quiet: boolean; headed: boolean }
): PhaseVerdict {
  const { state, quiet, headed } = host;
  if (verdict.state !== 'failed' || verdict.quarantine !== undefined || state === undefined)
    return verdict;
  const seen = (what: string, at: number | undefined, applies = true): string[] =>
    applies && at !== undefined ? [`${what} ${String(at)}s in`] : [];
  const causes = [
    ...seen('the network went away', state.networkLost),
    ...seen('the lid closed', state.lidClosed, quiet),
    ...seen('the display slept', state.displaySlept, quiet),
    ...seen('keyboard or pointer input reached the host', state.input, headed),
  ];
  if (causes.length === 0) return verdict;
  const said = causes.join(' and ');
  return {
    advance: false,
    state: 'interrupted',
    reason: `${said.charAt(0).toUpperCase()}${said.slice(1)}, so this red says nothing about the step: ${verdict.reason ?? 'red'}`,
  };
}

/** How much of a log's end is worth reading for its last complaint. */
const LOG_TAIL_BYTES = 64 * 1024;
const CAUSE_CHARACTERS = 240;

/** A line that reports a problem, rather than a harness or adapter talking. */
const COMPLAINT =
  /^\s*■|\b(?:error|errors|failed|failure|refused|refuses|cannot|fatal|exception|traceback)\b|TEST-UNEXPECTED|FIREFORGE-VERDICT: FAIL/i;

/** Where a test verdict says its run stopped: `started=<n>/<m> first-unstarted=<path>`. */
const STOPPED_AT = /^FIREFORGE-VERDICT: FAIL\b.*?\b(started=\d+\/\d+ first-unstarted=\S+)/;

/**
 * The most recent complaint in text, else its last line. A failed test
 * verdict's stopping point follows it, since the error rendered after the
 * verdict does not say how far the run got.
 */
function lastComplaint(text: string): string | undefined {
  const lines = stripVTControlCharacters(text)
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('FIREFORGE-JOB-STEP:'));
  const line = lines.findLast((entry) => COMPLAINT.test(entry)) ?? lines.at(-1);
  const complaint = line
    ?.replace(/^[\s■]+/, '')
    .trimEnd()
    .slice(0, CAUSE_CHARACTERS);
  const stopped = lines.findLast((entry) => STOPPED_AT.test(entry))?.match(STOPPED_AT)?.[1];
  return complaint === undefined || stopped === undefined || complaint.includes(stopped)
    ? complaint
    : `${complaint} (${stopped})`;
}

/** The cause a step's log gives for its end. A log that cannot be read gives none. */
export async function stepCause(logPath: string): Promise<string | undefined> {
  try {
    const file = await open(logPath, 'r');
    try {
      const { size } = await file.stat();
      const length = Math.min(size, LOG_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      return lastComplaint(buffer.toString('utf8'));
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}

/**
 * Bounds slow slot work that has no process of its own to signal, such as a
 * preparation or a seal stuck on a hung file system. The work keeps running, so
 * whatever `expired` builds has to condemn the slot rather than free it.
 */
export async function withinDeadline<T>(
  work: Promise<T>,
  milliseconds: number,
  expired: () => Error
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(expired());
    }, milliseconds);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a step may run by default, in seconds. */
export function defaultStepDeadline(step: JobStep): number {
  const traits = stepTraits(step);
  if ((step.command === 'build' && !traits.uiBuild) || traits.releaseBuild) return 6 * 3600;
  // A working session: it ends when its person closes the window or cancels.
  if (step.interactive === true) return 12 * 3600;
  if (traits.builds || step.command === 'test') return 2 * 3600;
  return 3600;
}
