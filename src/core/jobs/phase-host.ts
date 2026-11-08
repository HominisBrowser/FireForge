// SPDX-License-Identifier: EUPL-1.2
/** What a phase runner holds per job, and what it asks of the supervisor. */
import type { ChildProcess } from 'node:child_process';

import type { ProcessOwnership } from '../../utils/process-group.js';
import type { OwnedProcessTracker } from './process-tracker.js';
import type { JobRecord, ProcessIdentity } from './schema.js';

/** A job's hold on its slot, from admission to its last phase. */
export interface PhaseSession {
  release: () => Promise<void>;
  prepared: boolean;
  child?: ChildProcess;
  ownership?: ProcessOwnership;
  tracker?: OwnedProcessTracker;
  /** Why this phase's process tree went unobserved. It always condemns the slot. */
  ownershipError?: string;
  /** An executor was launched and its settlement has not established that everything is gone. */
  unsettled?: boolean;
  /** Set once the phase has to stop: when that was asked, and the last signal that was delivered. */
  stop?: { since: number; sent?: NodeJS.Signals };
}

/** The supervisor's side of the bargain: decisions and journal appends happen there, in order. */
export interface PhaseHost {
  readonly namespace: string;
  executorDigest: () => string;
  /** Runs a decision in the serial queue. */
  decide: <T>(work: () => Promise<T>) => Promise<T>;
  /** Journals a change, then applies it. Must run inside {@link PhaseHost.decide}. */
  transition: (job: JobRecord, mutate: (draft: JobRecord) => void) => Promise<void>;
  /** Journals a change and applies it even if the journal is unwritable, for a job that has to end. */
  settle: (job: JobRecord, mutate: (draft: JobRecord) => void) => Promise<void>;
  /** Applies a job's end but holds its row back until the mark on its slot lands. */
  settleLater: (job: JobRecord, mutate: (draft: JobRecord) => void) => void;
  logFault: (context: string, error: unknown) => void;
  /** Runs work for one job after that job's earlier work, guarded against any failure. */
  task: (job: JobRecord, work: () => Promise<void>) => void;
  nextTicket: () => number;
  requestSchedule: () => void;
  /** The executor a job is running right now. */
  liveProcess: (jobId: string) => ProcessIdentity | undefined;
}
