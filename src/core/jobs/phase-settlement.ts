// SPDX-License-Identifier: EUPL-1.2
import type { ChildProcess } from 'node:child_process';

import { toError } from '../../utils/errors.js';
import type { ProcessOwnership } from '../../utils/process-group.js';
import { currentResources } from './admission.js';
import { cleanupFailedExecutor } from './executor-cleanup.js';
import type { HeldGroup } from './host-quarantine.js';
import { groupHasLiveMembers, signalOwnedProcess } from './process.js';
import type { OwnedProcessTracker } from './process-tracker.js';
import { type JobRecord, jobSlot, type ProcessIdentity } from './schema.js';

/** A hold on a process group a job's phase left. */
export function heldGroup(job: JobRecord, group: number): HeldGroup {
  const slot = jobSlot(job);
  return {
    group,
    job: job.id,
    ...(slot === undefined ? {} : { slot }),
    ...(job.phase?.nonce === undefined ? {} : { phase: job.phase.nonce }),
    resources: currentResources(job),
  };
}

/** What a finished phase left behind, as far as can be established. */
export interface Settlement {
  /** Why its processes cannot be established as gone, when they cannot. */
  uncertain?: string;
  detached?: JobRecord['detached'];
  /** Written by whoever concludes the job, which remembers them until they land. */
  holds: HeldGroup[];
}

/**
 * Establishes whether a finished phase left anything running. It never throws:
 * anything it cannot establish is uncertainty, recorded here before anything has
 * to be written.
 */
export async function settleProcesses(
  job: JobRecord,
  session: { tracker?: OwnedProcessTracker; ownershipError?: string }
): Promise<Settlement> {
  const leader = job.process;
  let uncertain = session.ownershipError;
  let detached: JobRecord['detached'];
  const holds: HeldGroup[] = [];
  try {
    const cleanup = await session.tracker?.finish();
    detached = cleanup?.detached;
    for (const entry of cleanup?.unknown ?? []) holds.push(heldGroup(job, entry.group));
    if (cleanup?.clean === false)
      uncertain ??= `processes still run: ${cleanup.unknown.map((entry) => entry.pid).join(', ')}`;
  } catch (error) {
    uncertain = toError(error).message;
    if (leader !== undefined) holds.push(heldGroup(job, leader.pid));
  }
  if (leader === undefined) uncertain ??= 'the executor has no recorded identity';
  else
    try {
      if (await groupHasLiveMembers(leader.pid)) {
        holds.push(heldGroup(job, leader.pid));
        uncertain ??= `process group ${String(leader.pid)} still has members`;
      }
    } catch (error) {
      holds.push(heldGroup(job, leader.pid));
      uncertain ??= toError(error).message;
    }
  return {
    holds,
    ...(uncertain === undefined ? {} : { uncertain }),
    ...(detached === undefined ? {} : { detached }),
  };
}

/**
 * Tears down an executor whose launch failed.
 *
 * @returns Why that could not be established, when it could not
 */
export async function tearDownLaunch(
  job: JobRecord,
  session: {
    child?: ChildProcess;
    ownership?: ProcessOwnership;
    tracker?: OwnedProcessTracker;
    unsettled?: boolean;
  }
): Promise<string | undefined> {
  if (session.child === undefined) return undefined;
  const { child, tracker, ownership } = session;
  let uncertain: string | undefined;
  try {
    uncertain = await cleanupFailedExecutor({
      child,
      ...(job.process ? { identity: job.process } : {}),
      ...(ownership ? { ownership } : {}),
      ...(tracker ? { tracker } : {}),
    });
  } catch (cleanup) {
    uncertain = toError(cleanup).message;
  }
  delete session.child;
  session.unsettled = uncertain !== undefined;
  return uncertain;
}

/**
 * Signals every session's live executor, then kills it after the grace, with
 * nothing journaled: the namespace recording them is gone.
 */
export function abandonSessions(
  sessions: ReadonlyMap<string, { child?: ChildProcess }>,
  liveProcess: (jobId: string) => ProcessIdentity | undefined,
  graceMs: number
): void {
  for (const [id, session] of sessions) {
    const identity = liveProcess(id);
    if (identity === undefined || session.child === undefined) continue;
    void signalOwnedProcess(identity, 'SIGTERM');
    setTimeout(() => {
      void signalOwnedProcess(identity, 'SIGKILL');
    }, graceMs).unref();
  }
}
