// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { getNodeErrorCode } from '../../utils/errors.js';
import {
  groupMembers,
  type ProcessSnapshot,
  snapshotProcesses,
} from '../../utils/process-birth.js';
import { withFileLock } from '../file-lock.js';
import { phaseMarkedProcesses } from './process-tracker.js';
import type { ProcessIdentity, ResourceVector } from './schema.js';
import { RESOURCE_NAMES } from './schema.js';
import { readJson, writeDurable } from './store.js';

/**
 * A process group that outlived its phase. It holds its own slot (through the
 * slot's quarantine) and the resources its phase held, until it is observed
 * gone. Nothing else on the host waits for it.
 */
export interface HeldGroup {
  group: number;
  job: string;
  slot?: string;
  /** The phase marker, for a census that could not read the group at the time. */
  phase?: string;
  resources?: ResourceVector;
  /** Exact births seen in this group. A process number alone says nothing once it is reused. */
  members?: ProcessIdentity[];
}

interface HostQuarantine {
  /** A reason the whole host cannot be trusted, which only an explicit clear removes. */
  unknown?: string;
  groups: HeldGroup[];
}

const stateFile = (namespace: string): string => join(namespace, 'host-quarantine.json');

async function readState(namespace: string): Promise<HostQuarantine> {
  try {
    return await readJson<HostQuarantine>(stateFile(namespace));
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    return { groups: [] };
  }
}

/** One read-modify-write at a time, across per-job tasks, the heartbeat and `slot restore`. */
function withStateLock<T>(namespace: string, work: () => Promise<T>): Promise<T> {
  return withFileLock(`${stateFile(namespace)}.lock`, work, { timeoutMs: 30_000 });
}

async function updateState(
  namespace: string,
  change: (state: HostQuarantine) => void
): Promise<void> {
  await withStateLock(namespace, async () => {
    const state = await readState(namespace);
    change(state);
    await writeDurable(stateFile(namespace), state);
  });
}

const identityOf = ({ pid, start }: ProcessIdentity): ProcessIdentity => ({ pid, start });

const sameBirth = (a: ProcessIdentity, b: ProcessIdentity): boolean =>
  a.pid === b.pid && a.start === b.start;

/**
 * Records a group that outlived its phase, with the births in it now. The first
 * record of a group wins.
 */
export async function holdHostGroup(namespace: string, held: HeldGroup): Promise<void> {
  const snapshot = held.members === undefined ? await snapshotProcesses() : undefined;
  const members =
    held.members ??
    (snapshot === undefined ? [] : groupMembers(snapshot, held.group).map(identityOf));
  await updateState(namespace, (state) => {
    if (!state.groups.some((entry) => entry.group === held.group))
      state.groups.push({ ...held, members });
  });
}

/** Marks the whole host untrusted. Reserved for uncertainty no process group can scope. */
export async function quarantineHostUnknown(namespace: string, reason: string): Promise<void> {
  await updateState(namespace, (state) => {
    state.unknown ??= reason;
  });
}

/**
 * Whether a hold still means anything, by the census. A process carrying the
 * phase's marker keeps it. So does a live member with a recorded birth, while a
 * live member with neither is an unrelated process that was given a recycled
 * number. Undefined means the census could not say.
 */
async function groupGone(
  entry: HeldGroup,
  snapshot: ProcessSnapshot | undefined
): Promise<boolean | undefined> {
  if (snapshot === undefined) return undefined;
  let marked: readonly unknown[] = [];
  if (entry.phase !== undefined) {
    try {
      marked = await phaseMarkedProcesses(entry.phase);
    } catch {
      return undefined;
    }
  }
  if (marked.length > 0) return false;
  const members = groupMembers(snapshot, entry.group);
  if (members.length === 0) return true;
  const recorded = entry.members ?? [];
  // A hold made when the census could not name anyone has nothing to compare with.
  if (recorded.length === 0) return false;
  return !members.some((member) => recorded.some((birth) => sameBirth(birth, member)));
}

/** What the host's own state does to admission right now. */
export interface HostObservation {
  /** Why nothing may start, when something host-wide says so. */
  blocked?: string;
  /** Resources still held by groups that outlived their phase. */
  held: ResourceVector;
  groups: HeldGroup[];
}

/** Reads the host's state, forgetting groups the census shows gone. Never starts anything. */
export async function observeHost(namespace: string): Promise<HostObservation> {
  const held: ResourceVector = { cpu: 0, memory: 0, build: 0, browser: 0, display: 0 };
  const state = await readState(namespace);
  const snapshot = state.groups.length === 0 ? undefined : await snapshotProcesses();
  const live: HeldGroup[] = [];
  const gone = new Set<number>();
  const grown = new Map<number, ProcessIdentity[]>();
  for (const entry of state.groups) {
    if ((await groupGone(entry, snapshot)) === true) {
      gone.add(entry.group);
      continue;
    }
    live.push(entry);
    for (const name of RESOURCE_NAMES) held[name] += entry.resources?.[name] ?? 0;
    // A survivor's children inherit its group: their births keep the hold recognisable after it exits.
    const members = snapshot === undefined ? [] : groupMembers(snapshot, entry.group);
    if (
      entry.members !== undefined &&
      members.some((member) => !entry.members?.some((birth) => sameBirth(birth, member)))
    )
      grown.set(entry.group, members.map(identityOf));
  }
  if (gone.size > 0 || grown.size > 0)
    await updateState(namespace, (current) => {
      current.groups = current.groups
        .filter((entry) => !gone.has(entry.group))
        .map((entry) => {
          const members = grown.get(entry.group);
          return members === undefined
            ? entry
            : { ...entry, members: [...(entry.members ?? []), ...members] };
        });
    });
  return {
    ...(state.unknown === undefined ? {} : { blocked: quarantineBlock(state.unknown) }),
    held,
    groups: live,
  };
}

const quarantineBlock = (reason: string): string =>
  `Host quarantined: ${reason}. Once this is resolved, run: fireforge job host-clear`;

/**
 * The host quarantine as recorded now, without a census. Admission reads it again
 * when it decides, since one written after its observation still stops a start.
 */
export async function hostQuarantineBlock(namespace: string): Promise<string | undefined> {
  const { unknown } = await readState(namespace);
  return unknown === undefined ? undefined : quarantineBlock(unknown);
}

/**
 * Clears the host quarantine once a census establishes nothing it names still
 * runs. A live group is refused by name: stopping it is your call. `forget` names
 * groups you have established are not this job's, which clears them regardless.
 *
 * @returns What was cleared
 * @throws When a group not named in `forget` still runs, or the census is unavailable
 */
export async function clearHostQuarantine(
  namespace: string,
  forget: readonly number[] = []
): Promise<{ cleared: string[] }> {
  const snapshot = await snapshotProcesses();
  if (snapshot === undefined)
    throw new Error('Cannot clear the host quarantine: the process census is unavailable');
  return withStateLock(namespace, async () => {
    const state = await readState(namespace);
    const live: HeldGroup[] = [];
    for (const entry of state.groups)
      if (!forget.includes(entry.group) && (await groupGone(entry, snapshot)) !== true)
        live.push(entry);
    if (live.length > 0)
      throw new Error(
        `Cannot clear the host quarantine: process groups still run: ${live
          .map((entry) => `${String(entry.group)} (job ${entry.job})`)
          .join(
            ', '
          )}. Stop them, or if a number now belongs to something else: fireforge job host-clear --forget-group <group>`
      );
    await rm(stateFile(namespace), { force: true });
    return {
      cleared: [
        ...(state.unknown === undefined ? [] : [state.unknown]),
        ...state.groups.map((entry) => `process group ${String(entry.group)} (job ${entry.job})`),
      ],
    };
  });
}
