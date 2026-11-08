// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../../utils/errors.js';
import { groupMembers, snapshotProcesses } from '../../utils/process-birth.js';
import { sleep } from '../../utils/sleep.js';
import { currentResources } from './admission.js';
import { type HeldGroup, holdHostGroup } from './host-quarantine.js';
import { isSameProcess, signalOwnedProcess } from './process.js';
import {
  finishOwnedProcesses,
  phaseMarkedProcesses,
  readProcessLedger,
} from './process-tracker.js';
import { type JobRecord, jobSlot, type ProcessIdentity, terminal } from './schema.js';
import { quarantineSlot, slotMetadataUnreadable } from './slot-lock.js';
import { readSlot } from './slots.js';
import {
  appendTransition,
  damagedJournalPath,
  isolateDamagedRows,
  readJournalContents,
} from './store.js';

const ledgerPath = (namespace: string, job: JobRecord): string =>
  join(namespace, 'artifacts', job.id, `step-${String(job.phase?.index ?? 0)}-processes.json`);

/**
 * Whether anything in a leader's group is this job's. A number alone is not: after
 * a reboot or a wrap it can belong to anything. A member counts by a birth this
 * phase's ledger recorded, or by carrying the phase's marker.
 */
async function leaderGroupStillOurs(
  leader: ProcessIdentity,
  births: readonly ProcessIdentity[],
  phase: string | undefined
): Promise<boolean> {
  const snapshot = await snapshotProcesses();
  if (snapshot === undefined) return true;
  const members = groupMembers(snapshot, leader.pid);
  if (members.length === 0) return false;
  if (
    members.some((member) => births.some((b) => b.pid === member.pid && b.start === member.start))
  )
    return true;
  if (phase === undefined) return false;
  const marked = await phaseMarkedProcesses(phase).catch(() => undefined);
  return marked === undefined || marked.some((row) => row.group === leader.pid);
}

/** Stops what an interrupted job left running and names any group that will not establish as gone. */
async function reconcileProcesses(
  namespace: string,
  job: JobRecord,
  slot: string
): Promise<HeldGroup[]> {
  const leader = job.process;
  if (leader === undefined) return [];
  if (await isSameProcess(leader)) {
    await signalOwnedProcess(leader, 'SIGTERM');
    for (let count = 0; count < 20 && (await isSameProcess(leader)); count += 1) await sleep(50);
    if (await isSameProcess(leader)) await signalOwnedProcess(leader, 'SIGKILL');
  }
  const held = {
    job: job.id,
    slot,
    ...(job.phase?.nonce === undefined ? {} : { phase: job.phase.nonce }),
    resources: currentResources(job),
  };
  const holds: HeldGroup[] = [];
  const hold = (group: number, members?: ProcessIdentity[]): void => {
    if (!holds.some((entry) => entry.group === group))
      holds.push({ ...held, group, ...(members === undefined ? {} : { members }) });
  };
  try {
    const ledger = ledgerPath(namespace, job);
    const births = [leader, ...(await readProcessLedger(ledger)).map((entry) => entry.identity)];
    if (await leaderGroupStillOurs(leader, births, job.phase?.nonce)) hold(leader.pid, births);
    const record = await readSlot(namespace, slot);
    const cleanup = await finishOwnedProcesses(ledger, record.root, leader.pid, job.phase?.nonce);
    for (const unknown of cleanup.unknown) hold(unknown.group);
  } catch {
    // The census or ledger is unreadable now. The marker lets a later census settle this.
    hold(leader.pid, [leader]);
  }
  return holds;
}

const INTERRUPTION = 'Supervisor interruption requires explicit restore and boundary audit';

/**
 * Writes what a job left on its slot.
 *
 * @returns False when that has to be tried again. Metadata no read can get through
 * already reads as quarantined, so the job's own record says what happened.
 */
async function landMark(
  namespace: string,
  job: JobRecord,
  slot: string,
  holds: readonly HeldGroup[]
): Promise<boolean> {
  try {
    await quarantineSlot(namespace, slot, INTERRUPTION);
  } catch (error) {
    if (!slotMetadataUnreadable(error)) return false;
    job.reason = `${job.reason ?? ''}; recovery of slot ${slot} was incomplete: ${toError(error).message}`;
  }
  try {
    for (const held of holds) await holdHostGroup(namespace, held);
    return true;
  } catch {
    return false;
  }
}

/** A job whose marks on its slot have to land before its row may say it ended. */
export interface RecoveredMark {
  job: string;
  slot: string;
  quarantine: string;
  holds: HeldGroup[];
}

/**
 * Reconcile owned processes and partial seals before publishing a new epoch.
 * Each job recovers on its own: one damaged slot marks only its job, and nothing
 * here stops the supervisor's start. A damaged journal row is moved aside the same
 * way, costing only the job it was the latest record of. A slot mark that cannot
 * land yet is handed back with the job's row unwritten, so the slot stays
 * unavailable meanwhile and a crash has the next start repeat all of this.
 */
export async function recoverJobJournal(
  namespace: string,
  epoch: number
): Promise<{
  jobs: Map<string, JobRecord>;
  nextTicket: number;
  marks: RecoveredMark[];
  damaged: number;
}> {
  const { jobs, damaged } = await readJournalContents(namespace, { repairTail: true });
  const lost = new Set(damaged.flatMap((row) => (row.job === undefined ? [] : [row.job])));
  // The sidecar has to land first. Should this fail, the rows stay and the next start tries again.
  if (damaged.length > 0)
    await isolateDamagedRows(namespace, damaged, jobs.values()).catch(() => undefined);
  let nextTicket = 1;
  const marks: RecoveredMark[] = [];
  for (const job of jobs.values()) {
    nextTicket = Math.max(nextTicket, (job.phase?.ticket ?? 0) + 1);
    const damagedRow = lost.has(job.id);
    if (terminal(job.state) || (job.state === 'queued' && !damagedRow)) continue;
    let reason = damagedRow
      ? `A journal row of this job was damaged; it is kept in ${damagedJournalPath(namespace)}`
      : 'Supervisor restarted before durable evidence sealing';
    const slot = job.state === 'queued' ? undefined : jobSlot(job);
    let holds: HeldGroup[] = [];
    try {
      await rm(join(namespace, 'receipts', `${job.id}.json`), { force: true });
      if (slot !== undefined) holds = await reconcileProcesses(namespace, job, slot);
    } catch (error) {
      reason = `${reason}; recovery of slot ${slot ?? '(none)'} was incomplete: ${toError(error).message}`;
    }
    job.state = 'interrupted';
    job.reason = reason;
    delete job.executionToken;
    job.epoch = epoch;
    job.updatedAt = new Date().toISOString();
    if (slot !== undefined && !(await landMark(namespace, job, slot, holds))) {
      marks.push({ job: job.id, slot, quarantine: INTERRUPTION, holds });
      continue;
    }
    await appendTransition(namespace, job);
  }
  return { jobs, nextTicket, marks, damaged: damaged.length };
}
