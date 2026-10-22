// SPDX-License-Identifier: EUPL-1.2
/**
 * Waiter tickets for `withFileLock`: who is queued for a contended lock, in
 * what order, and whose turn it is.
 *
 * The tickets decide the grant: only the head of the queue may attempt the
 * lock, so the position printed is the position honoured. A free-for-all of
 * `mkdir` polls would let later arrivals polling at 100 ms take every free
 * moment from a waiter whose poll interval had backed off to 2 s, so a run
 * told it was next could watch later runs take the lock in turn.
 *
 * A ticket is a file in `<lock>.waiters/` named
 * `<startedAtMs>-<pid>-<uuid>`. Arrival order is the wait start, with the
 * whole name as a tie-break so every reader sorts the queue identically.
 * Because a ticket blocks everyone behind it, a ticket whose owner is
 * gone must not hold the queue: a dead PID (or a reused one, where the
 * start-tick check can tell) drops out and its ticket is removed, and a
 * ticket its owner has stopped refreshing drops out without being removed,
 * which covers a stopped (^Z) waiter and a reused PID on platforms with no
 * start tick.
 */
import { randomUUID } from 'node:crypto';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { toError } from '../utils/errors.js';
import { ensureDir } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { isLockOwnerAlive, readProcessStartTick } from './file-lock-owner.js';

/**
 * Live queue state around a contended lock: how many are queued and how many
 * are ahead of you. Waiters are granted the lock in arrival order, so `ahead`
 * is the number of grants that happen before yours.
 */
export interface LockQueueState {
  /** Live waiters currently queued for the lock, including this process. */
  depth: number;
  /** Live waiters that arrived before this process. */
  ahead: number;
}

/**
 * How often a waiter refreshes its ticket. Every wait loop iteration
 * refreshes once this much time has passed, and no caller sleeps longer
 * than a few seconds between iterations.
 */
const WAITER_HEARTBEAT_MS = 5_000;

/**
 * A ticket not refreshed for this long is skipped when the queue is read.
 * Six heartbeats of slack: long enough that a loaded host never skips a
 * waiter that is merely slow, short enough that a stopped waiter does not
 * hold the head of the queue for more than half a minute.
 */
export const WAITER_STALE_MS = 30_000;

/** Prefix of the ticket line carrying the waiter's process start tick. */
const START_TICK_PREFIX = 'start-tick=';

/** Sibling directory holding the waiter tickets of a lock. */
export function lockWaitersDir(lockPath: string): string {
  return `${lockPath}.waiters`;
}

interface WaiterTicket {
  name: string;
  startedAt: number;
  pid: number;
}

/** Parses a ticket name: `<startedAtMs>-<pid>-<uuid>`. */
function parseTicketName(name: string): WaiterTicket | undefined {
  const match = /^(\d+)-(\d+)-/.exec(name);
  const startedAt = match?.[1];
  const pid = match?.[2];
  if (startedAt === undefined || pid === undefined) return undefined;
  return { name, startedAt: Number.parseInt(startedAt, 10), pid: Number.parseInt(pid, 10) };
}

/** Arrival order: wait start first, then the name, so every reader agrees. */
function compareTickets(a: WaiterTicket, b: WaiterTicket): number {
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/** Reads the start tick a ticket recorded, when its writer could record one. */
async function readTicketStartTick(path: string): Promise<number | undefined> {
  const content = await readFile(path, 'utf-8');
  const line = content.split('\n').find((entry) => entry.startsWith(START_TICK_PREFIX));
  if (line === undefined) return undefined;
  const tick = Number.parseInt(line.slice(START_TICK_PREFIX.length), 10);
  return Number.isFinite(tick) ? tick : undefined;
}

/**
 * Whether a ticket still holds a place in the queue. A ticket whose owner is
 * provably gone is removed so the directory does not accumulate them; one
 * that has merely stopped being refreshed is skipped but left alone, since
 * its owner may resume and refresh it.
 */
async function isTicketLive(dir: string, ticket: WaiterTicket, now: number): Promise<boolean> {
  const path = join(dir, ticket.name);
  let startTick: number | undefined;
  let mtimeMs: number;
  try {
    startTick = await readTicketStartTick(path);
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    // Deregistered between the listing and this read.
    return false;
  }
  if (!isLockOwnerAlive({ pid: ticket.pid, startTick })) {
    await rm(path, { force: true }).catch((error: unknown) => {
      verbose(`Could not remove dead lock waiter ticket ${path}: ${toError(error).message}`);
    });
    return false;
  }
  return now - mtimeMs <= WAITER_STALE_MS;
}

/**
 * This process's view of itself in the queue: its wait start, and its ticket
 * when it holds one. Without a ticket the position falls back to comparing
 * wait starts, which is what a waiter whose registration failed can know.
 */
export interface QueueSelf {
  startedAt: number;
  ticket?: string | undefined;
}

/**
 * Reads the live waiter queue around `lockPath`.
 *
 * Advisory and fail-open: an unreadable registry reports an empty queue
 * rather than failing whatever asked. The caller's own ticket always counts
 * as live, since this process knows it is waiting.
 *
 * @param lockPath - The lock directory whose queue to inspect
 * @param self - This waiter, to compute `ahead`
 */
export async function readLockQueue(lockPath: string, self?: QueueSelf): Promise<LockQueueState> {
  const dir = lockWaitersDir(lockPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { depth: 0, ahead: 0 };
  }
  const now = Date.now();
  const tickets = names
    .map(parseTicketName)
    .filter((ticket): ticket is WaiterTicket => ticket !== undefined);
  const liveFlags = await Promise.all(
    tickets.map((ticket) =>
      ticket.name === self?.ticket ? Promise.resolve(true) : isTicketLive(dir, ticket, now)
    )
  );
  const live = tickets.filter((_, index) => liveFlags[index] === true);
  if (self === undefined) return { depth: live.length, ahead: 0 };
  if (self.ticket === undefined) {
    return {
      depth: live.length,
      ahead: live.filter((ticket) => ticket.startedAt < self.startedAt).length,
    };
  }
  const own = parseTicketName(self.ticket);
  // Our ticket can be missing from the listing only if something removed it;
  // we still count ourselves, and the next heartbeat recreates it.
  const listed = live.some((ticket) => ticket.name === self.ticket);
  return {
    depth: live.length + (listed ? 0 : 1),
    ahead:
      own === undefined
        ? 0
        : live.filter((ticket) => ticket.name !== own.name && compareTickets(ticket, own) < 0)
            .length,
  };
}

/** A waiter's place in the queue, from joining it to leaving it. */
export interface WaiterRegistration {
  /** Ticket name, or `undefined` when registration failed. */
  ticket: string | undefined;
  /** Refreshes the ticket when a heartbeat is due. Never throws. */
  heartbeat: () => Promise<void>;
  /** Leaves the queue. Always safe to call. */
  deregister: () => Promise<void>;
}

/**
 * Takes a ticket in the lock's waiter queue.
 *
 * Never fails the acquisition: a registry that cannot be written yields a
 * registration without a ticket, and the waiter falls back to contending
 * for the lock without queue order, which is how every waiter behaved
 * before tickets decided the grant.
 *
 * @param lockPath - The contended lock directory
 * @param startedAt - When this waiter started waiting (its arrival time)
 */
export async function registerWaiter(
  lockPath: string,
  startedAt: number
): Promise<WaiterRegistration> {
  const dir = lockWaitersDir(lockPath);
  const ticket = `${startedAt}-${process.pid}-${randomUUID()}`;
  const file = join(dir, ticket);
  const startTick = readProcessStartTick(process.pid);
  const content = `${process.pid}\n${startTick !== undefined ? `${START_TICK_PREFIX}${startTick}\n` : ''}`;
  try {
    await ensureDir(dir);
    await writeFile(file, content, 'utf-8');
  } catch (error: unknown) {
    verbose(`Could not register lock waiter for ${lockPath}: ${toError(error).message}`);
    return {
      ticket: undefined,
      heartbeat: async (): Promise<void> => {
        /* nothing to refresh */
      },
      deregister: async (): Promise<void> => {
        /* nothing to remove */
      },
    };
  }
  let lastBeatAt = Date.now();
  return {
    ticket,
    heartbeat: async (): Promise<void> => {
      if (Date.now() - lastBeatAt < WAITER_HEARTBEAT_MS) return;
      lastBeatAt = Date.now();
      try {
        // A rewrite, not a utimes: it also recreates a ticket that was
        // removed while this process was stopped long enough to look dead.
        await ensureDir(dir);
        await writeFile(file, content, 'utf-8');
      } catch (error: unknown) {
        verbose(`Could not refresh lock waiter ticket ${file}: ${toError(error).message}`);
      }
    },
    deregister: async (): Promise<void> => {
      try {
        await rm(file, { force: true });
      } catch (error: unknown) {
        // A leftover ticket of a process about to exit drops out on its own
        // (dead PID), so this never needs to fail the caller.
        verbose(`Could not remove lock waiter ticket ${file}: ${toError(error).message}`);
      }
    },
  };
}

/**
 * Renders the queue position for a wait line, with the ordering rule, so the
 * reader knows the count is a promise and not a snapshot. Empty when nothing
 * is queued.
 */
export function formatLockQueuePosition(queue: LockQueueState | undefined): string {
  if (queue === undefined || queue.depth === 0) return '';
  if (queue.ahead === 0) {
    return ` You are next in a queue of ${queue.depth} (granted in arrival order).`;
  }
  return ` ${queue.ahead} ahead of you (queue of ${queue.depth}, granted in arrival order).`;
}
