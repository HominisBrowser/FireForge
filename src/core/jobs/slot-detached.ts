// SPDX-License-Identifier: EUPL-1.2
/**
 * What a phase left running in a slot's name. A self-detached process with no
 * foothold in the slot is left running and the phase stands, but it can still
 * reach into the slot later. The slot remembers each one by its exact birth, and
 * every later admission audit looks again: one that has since taken a foothold
 * quarantines the slot by name.
 */
import { realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import {
  isAliveIn,
  type ProcessSnapshot,
  readProcessCommands,
  snapshotProcesses,
} from '../../utils/process-birth.js';
import { commandNamesRoot } from '../../utils/process-listing.js';
import type { JobRecord } from './schema.js';
import { SlotIntegrityError } from './slot-audit.js';
import { slotFootholdHolders, type SlotHolder } from './slot-holders.js';
import { quarantineSlot } from './slot-lock.js';
import type { SlotRecord } from './slot-types.js';
import { readJson, slotDirectory, writeDurable } from './store.js';

/**
 * The record's file in the slot's private directory. It describes processes,
 * not the slot's bytes, so nothing that copies a slot copies it.
 */
export const DETACHED_RECORD = 'detached.json';

/** The most processes a slot remembers; the oldest go first. */
export const DETACHED_RECORD_LIMIT = 32;

/** One process a phase left detached here. */
export interface DetachedEntry {
  pid: number;
  /** Its birth, so a reused pid is never taken for it. */
  start: string;
  command?: string;
  /** The job whose phase left it. */
  job: string;
  /** When it was recorded. */
  at: string;
}

interface DetachedRecordFile {
  schemaVersion: 1;
  processes: DetachedEntry[];
}

/** Reads the process table and footholds; a test replaces them. */
export interface DetachedProbes {
  snapshot?: () => Promise<ProcessSnapshot | undefined>;
  footholds?: (
    pids: readonly number[],
    roots: readonly string[]
  ) => Promise<Map<number, SlotHolder>>;
  commands?: (pids: readonly number[]) => Promise<Map<number, string>>;
}

const recordPath = (namespace: string, id: string): string =>
  join(slotDirectory(namespace, id), DETACHED_RECORD);

/** The processes a slot remembers. A record that cannot be parsed remembers none. */
export async function readDetachedRecord(namespace: string, id: string): Promise<DetachedEntry[]> {
  try {
    const file = await readJson<DetachedRecordFile>(recordPath(namespace, id));
    return Array.isArray(file.processes)
      ? file.processes.filter(
          (entry) =>
            Number.isSafeInteger(entry.pid) &&
            typeof entry.start === 'string' &&
            typeof entry.job === 'string'
        )
      : [];
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

async function writeRecord(
  namespace: string,
  id: string,
  processes: readonly DetachedEntry[]
): Promise<void> {
  if (processes.length === 0) {
    await clearDetachedRecord(namespace, id);
    return;
  }
  const file: DetachedRecordFile = {
    schemaVersion: 1,
    processes: processes.slice(-DETACHED_RECORD_LIMIT),
  };
  await writeDurable(recordPath(namespace, id), file);
}

/**
 * Remembers what a job's phase left detached. Caller holds the slot. An entry
 * without a birth is identified now, while it lives; one already gone is not
 * remembered.
 *
 * @param namespace - Host coordinator namespace
 * @param id - The slot
 * @param job - The job whose phase left them
 * @param detached - The processes, as the phase's settlement reported them
 */
export async function recordDetached(
  namespace: string,
  id: string,
  job: string,
  detached: NonNullable<JobRecord['detached']>,
  probes: Pick<DetachedProbes, 'snapshot'> = {}
): Promise<void> {
  const unborn = detached.filter((entry) => entry.start === undefined);
  const snapshot = unborn.length === 0 ? undefined : await (probes.snapshot ?? snapshotProcesses)();
  const at = new Date().toISOString();
  const added = detached.flatMap((entry): DetachedEntry[] => {
    const start = entry.start ?? snapshot?.get(entry.pid)?.start;
    if (start === undefined) return [];
    return [
      {
        pid: entry.pid,
        start,
        ...(entry.command === undefined ? {} : { command: entry.command }),
        job,
        at,
      },
    ];
  });
  if (added.length === 0) return;
  const same = (a: DetachedEntry, b: DetachedEntry): boolean =>
    a.pid === b.pid && a.start === b.start;
  const kept = (await readDetachedRecord(namespace, id)).filter(
    (entry) => !added.some((other) => same(entry, other))
  );
  await writeRecord(namespace, id, [...kept, ...added]);
}

/** Forgets every process a slot remembers. */
export async function clearDetachedRecord(namespace: string, id: string): Promise<void> {
  await rm(recordPath(namespace, id), { force: true });
}

const describe = (entry: DetachedEntry, command: string | undefined): string =>
  `process ${String(entry.pid)} (${command ?? entry.command ?? 'command unreadable'})`;

/**
 * Looks again at every process this slot remembers. One that has gone, or whose
 * pid now names another process, is forgotten. One that still lives with no
 * foothold stays remembered. One that now holds a path under the slot, or whose
 * command line names it, quarantines the slot by name. A process table that
 * cannot be read changes nothing: the audit's own census of holders still runs.
 * Caller holds the slot.
 *
 * @param namespace - Host coordinator namespace
 * @param slot - The slot about to be audited
 * @throws {SlotIntegrityError} When a remembered process has reached into the slot
 */
export async function reviewDetached(
  namespace: string,
  slot: SlotRecord,
  probes: DetachedProbes = {}
): Promise<void> {
  const recorded = await readDetachedRecord(namespace, slot.id);
  if (recorded.length === 0) return;
  const snapshot = await (probes.snapshot ?? snapshotProcesses)();
  if (snapshot === undefined) return;
  const live = recorded.filter((entry) => isAliveIn(snapshot, entry));
  if (live.length === 0) {
    await clearDetachedRecord(namespace, slot.id);
    return;
  }
  const roots = [slot.root, await realpath(slot.root).catch(() => slot.root)];
  const pids = live.map((entry) => entry.pid);
  const holders = await (probes.footholds ?? slotFootholdHolders)(pids, roots);
  const commands = await (probes.commands ?? readProcessCommands)(pids);
  const findings = live.flatMap((entry) => {
    const command = commands.get(entry.pid);
    const holder = holders.get(entry.pid);
    const what =
      holder !== undefined
        ? `now holds ${holder.held ?? 'a path under the slot it could not name'}`
        : command !== undefined && roots.some((root) => commandNamesRoot(command, root))
          ? 'now names the slot in its command line'
          : undefined;
    return what === undefined
      ? []
      : [`${describe(entry, command)} left detached by job ${entry.job}, ${what}`];
  });
  await writeRecord(namespace, slot.id, live);
  if (findings.length === 0) return;
  const reason = findings.join('; ');
  await quarantineSlot(namespace, slot.id, reason);
  throw new SlotIntegrityError(reason);
}

/**
 * {@link recordDetached} for a phase that just settled. The phase stands either
 * way, so a record that cannot be written costs only the later look.
 */
export async function noteDetached(
  namespace: string,
  id: string,
  job: string,
  detached: NonNullable<JobRecord['detached']>
): Promise<void> {
  await recordDetached(namespace, id, job, detached).catch(() => undefined);
}
