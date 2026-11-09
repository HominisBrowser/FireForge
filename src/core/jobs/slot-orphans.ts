// SPDX-License-Identifier: EUPL-1.2
import { realpath } from 'node:fs/promises';
import { basename } from 'node:path';

import {
  isAliveIn,
  type ProcessSnapshot,
  signalIfAlive,
  snapshotProcesses,
} from '../../utils/process-birth.js';
import { isSupervisorCommand } from '../../utils/process-group.js';
import { listProcesses } from '../../utils/process-list.js';
import { commandNamesRoot } from '../../utils/process-listing.js';
import { sleep } from '../../utils/sleep.js';
import { phaseMarkedProcesses } from './process-tracker.js';
import { slotUsers } from './slot-holders.js';
import { readJournal } from './store.js';

/** A process that holds a slot, with the verdict on whether it is an orphan. */
export interface SlotHolderVerdict {
  pid: number;
  parent: number;
  command: string;
  /** The first path under the slot it was seen holding, when it holds one open. */
  held?: string;
  orphan: boolean;
  /** Why it is not an orphan, or what makes it one. */
  reason: string;
}

/** A process stopped by {@link stopSlotOrphans}. */
export interface StoppedOrphan {
  pid: number;
  command: string;
}

/** Grace between SIGTERM and SIGKILL. */
const TERM_GRACE_MS = 2_000;

/** The most a SIGKILLed process gets to leave the process table. */
const KILL_SETTLE_MS = 2_000;

const POLL_MS = 50;

const SHELLS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh']);

/** Timing for {@link stopSlotOrphans}; a test shortens it. */
export interface StopOrphanOptions {
  graceMs?: number;
  settleMs?: number;
}

interface Row {
  parent: number;
  command: string;
}

/** A shell that is not running a single `-c` command line: a person's, or an agent's. */
function interactiveShell(command: string): boolean {
  const [first = '', ...rest] = command.split(/\s+/);
  const name = basename(first).replace(/^-/, '');
  if (!SHELLS.has(name)) return false;
  return (
    first.startsWith('-') || first.endsWith('-') || !rest.some((word) => /^-\w*c\w*$/.test(word))
  );
}

/**
 * Whether one holder is an orphan. It is not one when it is this process, a
 * supervisor, or a running job's own process or descendant, nor when its line of
 * parents passes through an interactive shell. Everything else is: init's child,
 * or a process whose every ancestor is itself leftover work.
 */
export function judgeHolder(
  pid: number,
  table: ReadonlyMap<number, Row>,
  jobProcesses: ReadonlySet<number>,
  self: number = process.pid
): { orphan: boolean; reason: string } {
  const own = table.get(pid);
  if (own === undefined) return { orphan: false, reason: 'its command line cannot be read' };
  if (isSupervisorCommand(own.command)) return { orphan: false, reason: 'it is a supervisor' };
  const seen = new Set<number>();
  let current = pid;
  for (;;) {
    if (current === self) return { orphan: false, reason: 'it is this command or its parent' };
    if (jobProcesses.has(current))
      return {
        orphan: false,
        reason:
          current === pid
            ? 'it belongs to a running job'
            : `it descends from a running job (process ${String(current)})`,
      };
    const row = table.get(current);
    if (row === undefined || row.parent <= 1) break;
    if (seen.has(current)) break;
    seen.add(current);
    const parent = table.get(row.parent);
    if (parent === undefined) break;
    if (interactiveShell(parent.command))
      return {
        orphan: false,
        reason: `it descends from an interactive shell (process ${String(row.parent)}, ${parent.command})`,
      };
    current = row.parent;
  }
  return { orphan: true, reason: own.parent <= 1 ? 'its parent is init' : 'it has no live owner' };
}

/** Ancestors of this process, which a stop must never reach. */
function lineOf(pid: number, table: ReadonlyMap<number, Row>): Set<number> {
  const line = new Set<number>();
  for (let current = pid; current > 1 && !line.has(current);) {
    line.add(current);
    const parent = table.get(current)?.parent;
    if (parent === undefined) break;
    current = parent;
  }
  return line;
}

/** Processes a running job owns: its executor and whatever carries its active phase's marker. */
async function runningJobProcesses(namespace: string): Promise<Set<number>> {
  const owned = new Set<number>();
  for (const job of (await readJournal(namespace)).values()) {
    if (job.state !== 'running' && job.state !== 'sealing') continue;
    if (job.process !== undefined) owned.add(job.process.pid);
    if (job.phase?.nonce !== undefined)
      for (const row of await phaseMarkedProcesses(job.phase.nonce)) owned.add(row.pid);
  }
  return owned;
}

/**
 * Every process holding a slot, with the verdict on whether it is an orphan:
 * a working directory or open file under the root, or a command line naming it.
 *
 * @param namespace - Host coordinator namespace
 * @param root - The slot root
 */
export async function slotHolderVerdicts(
  namespace: string,
  root: string
): Promise<SlotHolderVerdict[]> {
  const roots = [root, await realpath(root).catch(() => root)];
  const users = await slotUsers(roots);
  const rows = await listProcesses(['pid', 'ppid', 'command']);
  const table = new Map(rows.map((row) => [row.pid, { parent: row.ppid, command: row.command }]));
  for (const row of rows)
    if (
      row.pid !== process.pid &&
      roots.some((candidate) => commandNamesRoot(row.command, candidate))
    )
      if (!users.has(row.pid)) users.set(row.pid, { writes: false });
  const jobs = await runningJobProcesses(namespace);
  const guarded = lineOf(process.pid, table);
  return [...users]
    .map(([pid, holder]) => {
      const verdict = guarded.has(pid)
        ? { orphan: false, reason: 'it is this command or its parent' }
        : judgeHolder(pid, table, jobs);
      return {
        pid,
        parent: table.get(pid)?.parent ?? 0,
        command: table.get(pid)?.command ?? '(unreadable)',
        ...(holder.held === undefined ? {} : { held: holder.held }),
        ...verdict,
      };
    })
    .sort((a, b) => a.pid - b.pid);
}

const describe = (holder: SlotHolderVerdict): string =>
  `process ${String(holder.pid)} (${holder.command})`;

/**
 * What to add to a refusal that names a slot's holders: the flag that stops
 * them when every one is an orphan. Empty when some holder is not, or none can be read.
 */
export async function orphanHint(namespace: string, root: string, name: string): Promise<string> {
  try {
    const holders = await slotHolderVerdicts(namespace, root);
    if (holders.length > 0 && holders.every((holder) => holder.orphan))
      return `. Every holder is an orphan (${holders.map(describe).join(', ')}); to stop them: fireforge slot restore ${name} --stop-orphans`;
  } catch {
    // The refusal stands without the hint.
  }
  return '';
}

async function waitUntilGone(
  targets: readonly { pid: number; start: string }[],
  budgetMs: number
): Promise<ProcessSnapshot> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const snapshot = (await snapshotProcesses()) ?? new Map();
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !targets.some((target) => isAliveIn(snapshot, target))) return snapshot;
    await sleep(Math.min(POLL_MS, remaining));
  }
}

/**
 * Stops the processes holding a slot that are orphans, and only those: SIGTERM,
 * a grace, then SIGKILL, each by its exact birth. Whatever is left, or whatever
 * is not an orphan, refuses by name.
 *
 * @param namespace - Host coordinator namespace
 * @param root - The slot root
 * @returns Each process stopped, with its command
 * @throws When a holder is not an orphan, or one survives its SIGKILL
 */
export async function stopSlotOrphans(
  namespace: string,
  root: string,
  options: StopOrphanOptions = {}
): Promise<StoppedOrphan[]> {
  const holders = await slotHolderVerdicts(namespace, root);
  const others = holders.filter((holder) => !holder.orphan);
  if (others.length > 0)
    throw new Error(
      `Cannot stop the orphans of this slot while ${others
        .map((holder) => `${describe(holder)} holds it and is not one (${holder.reason})`)
        .join('; ')}`
    );
  if (holders.length === 0) return [];
  const first = await snapshotProcesses();
  if (first === undefined)
    throw new Error('Cannot stop the orphans of this slot: the process census is unavailable');
  const targets = holders.flatMap((holder) => {
    const seen = first.get(holder.pid);
    return seen === undefined ? [] : [{ holder, pid: holder.pid, start: seen.start }];
  });
  for (const target of targets) signalIfAlive(first, target, 'SIGTERM');
  const afterGrace = await waitUntilGone(targets, options.graceMs ?? TERM_GRACE_MS);
  for (const target of targets) signalIfAlive(afterGrace, target, 'SIGKILL');
  const last = await waitUntilGone(targets, options.settleMs ?? KILL_SETTLE_MS);
  const surviving = targets.filter((target) => isAliveIn(last, target));
  if (surviving.length > 0)
    throw new Error(
      `Orphans survived SIGKILL: ${surviving.map((target) => describe(target.holder)).join(', ')}`
    );
  return targets.map(({ holder }) => ({ pid: holder.pid, command: holder.command }));
}
