// SPDX-License-Identifier: EUPL-1.2
/**
 * Locks between FireForge processes: exclusive, shared, and shared with a
 * limit on concurrent holders.
 *
 * A lock is a directory:
 *
 *     gate.<n>               owner record of generation n of the gate
 *     gate.<n>.free          generation n was released
 *     holder.<token>         owner record of a shared holder
 *     group.<token>.<pgid>   a process group that owner started while holding
 *     waiters/<ticket>       a queued waiter
 *     proposal.<pid>.<token> an owner record waiting to be linked into place
 *
 * The gate is the one atomic step. Its holder is whoever owns the highest
 * generation, and a generation file is only ever created, complete, by a hard
 * link, and never moved or removed until a higher one exists. Taking over
 * from a holder that died is therefore the same step as taking a free gate:
 * link the next generation. Two contenders that both saw the old holder dead
 * race on one link and one of them loses; nothing ever deletes a live claim.
 *
 * An exclusive holder keeps the gate for as long as it holds the lock, having
 * first waited for the shared holders to finish. A shared holder passes
 * through the gate: it takes it, records itself, and lets go. So shared
 * holders overlap each other, exclude an exclusive one, and cannot starve it,
 * because nobody new gets through a gate an exclusive waiter is holding.
 *
 * A holder is identified by pid and process start, so a reused pid is not
 * mistaken for it, and it stays a holder while any process group it started
 * under the lock still runs: a build that outlives a killed FireForge must
 * not overlap the next one. Locks are not reentrant.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { link } from 'node:fs/promises';
import { join } from 'node:path';

import { errnoCode, ExitCode, FireForgeError, toError } from './errors.js';
import { ensureDir, listDir, pathInfo, readTextIfExists, remove, writeFile } from './fs.js';
import { randomId } from './hash.js';
import { parseJson } from './json.js';
import { info, verbose, warn } from './log.js';
import {
  isIdentityAlive,
  isProcessAlive,
  isProcessGroupAlive,
  onProcessGroup,
  ownIdentity,
  processHasExited,
} from './process/index.js';
import { type Infer, s } from './schema.js';
import { onShutdown } from './signals.js';
import { formatDuration, sleep } from './time.js';

/** How a lock is held. */
export type LockMode = 'exclusive' | 'shared';

/** How a lock is taken. */
export interface LockOptions {
  /** `exclusive` (default) or `shared`. */
  mode?: LockMode;
  /** Shared mode only: at most this many holders at once. Omit for no limit. */
  limit?: number;
  /** How long to wait for the lock, in milliseconds (default 30 000). Zero does not wait. */
  waitMs?: number;
  /** Names the lock in messages: "engine" reads as "the engine lock". */
  label?: string;
  /** Describes this holder to whoever waits on it, such as `{ command: 'build' }`. */
  info?: Readonly<Record<string, string>>;
}

/** A process holding a lock. */
export interface LockHolder {
  pid: number;
  mode: LockMode;
  /** ISO timestamp of when the holder asked for the lock. */
  requestedAt: string;
  info: Readonly<Record<string, string>>;
}

/** Who holds a lock and how many wait for it. */
export interface LockStatus {
  holders: LockHolder[];
  /** Holders whose record could not be read. They count as holders. */
  unidentified: number;
  /** Live queued waiters. */
  waiting: number;
}

/** A lock this process holds. */
export interface HeldLock {
  readonly path: string;
  /** Releases the lock. Safe to call more than once. */
  release(): Promise<void>;
}

const OwnerRecord = s.object({
  pid: s.int({ min: 1 }),
  start: s.string().optional(),
  token: s.string({ min: 1 }),
  mode: s.enum(['exclusive', 'shared']),
  requestedAt: s.string(),
  info: s.record(s.string()),
});
type OwnerRecord = Infer<typeof OwnerRecord>;

const POLL_MIN_MS = 10;
const POLL_MAX_MS = 1_000;
/** Poll gap behind a shared taker that is only passing through the gate. */
const PASSING_POLL_MS = 5;
/** A probe that may cost a `ps` runs this often; polls in between use the cheap check. */
const THOROUGH_PROBE_MS = 5_000;
/** A waiter's first progress line comes after this long, later ones at {@link PROGRESS_EVERY_MS}. */
export const PROGRESS_FIRST_MS = 5_000;
export const PROGRESS_EVERY_MS = 60_000;
/**
 * How long a command waits by default for something another command holds
 * (the engine, a workspace, the display, a build slot): long enough for the
 * build holding it to finish, since waiting is what a parallel session
 * wants. Interrupting the wait stops it.
 */
export const COMMAND_WAIT_MS = 2 * 60 * 60 * 1000;
const TICKET_HEARTBEAT_MS = 5_000;
/**
 * A ticket not refreshed for this long is skipped, so a stopped waiter does
 * not hold the head of the queue. Six heartbeats of slack for a loaded host.
 */
const TICKET_STALE_MS = 30_000;
const GATE_ATTEMPTS = 8;
const GATE_FILE = /^gate\.(\d+)(\.free)?$/;

const gatePath = (dir: string, generation: number): string => join(dir, `gate.${generation}`);

/** A queued waiter's ticket: who is waiting. */
const TicketRecord = s.object({ pid: s.int(), start: s.string().optional() });

async function names(dir: string): Promise<string[]> {
  return (await listDir(dir)).map((entry) => entry.name);
}

/** A record that exists but cannot be read says nothing about its owner, so it is never reaped. */
async function readRecord(path: string): Promise<OwnerRecord | 'absent' | 'unreadable'> {
  try {
    const text = await readTextIfExists(path);
    if (text === undefined) return 'absent';
    const parsed = OwnerRecord.validate(parseJson(text));
    return parsed.ok ? parsed.value : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

async function liveGroups(dir: string, token: string): Promise<number[]> {
  const prefix = `group.${token}.`;
  return (await names(dir))
    .filter((name) => name.startsWith(prefix))
    .map((name) => Number(name.slice(prefix.length)))
    .filter((pgid) => Number.isSafeInteger(pgid) && isProcessGroupAlive(pgid));
}

async function ownerGone(dir: string, owner: OwnerRecord, thorough: boolean): Promise<boolean> {
  const alive = thorough ? !(await processHasExited(owner)) : isIdentityAlive(owner);
  return !alive && (await liveGroups(dir, owner.token)).length === 0;
}

async function readGate(dir: string): Promise<{ top: number; free: boolean }> {
  let top = 0;
  const released = new Set<number>();
  for (const name of await names(dir)) {
    const match = GATE_FILE.exec(name);
    if (match === null) continue;
    const generation = Number(match[1]);
    top = Math.max(top, generation);
    if (match[2] !== undefined) released.add(generation);
  }
  return { top, free: top === 0 || released.has(top) };
}

/**
 * Removes what a newer generation replaced, group markers no holder owns any
 * more, and proposals whose process is gone.
 */
async function retire(dir: string, generation: number, token: string): Promise<void> {
  const all = await names(dir);
  const owners = new Set([token]);
  for (const name of all) if (name.startsWith('holder.')) owners.add(name.slice('holder.'.length));
  for (const name of all) {
    const gate = GATE_FILE.exec(name);
    const [kind, field] = name.split('.');
    const stale =
      gate !== null
        ? Number(gate[1]) < generation
        : kind === 'group'
          ? !owners.has(field ?? '')
          : kind === 'proposal' && !isProcessAlive(Number(field));
    if (stale) await remove(join(dir, name));
  }
}

type GateAttempt = { generation: number } | { heldBy: OwnerRecord | 'unidentified' | 'contended' };

/** Takes the next generation of the gate, or reports who holds the current one. */
async function takeGate(attempt: Attempt, thorough: boolean): Promise<GateAttempt> {
  const { dir, token } = attempt;
  for (let round = 0; round < GATE_ATTEMPTS; round += 1) {
    const { top, free } = await readGate(dir);
    if (!free) {
      const owner = await readRecord(gatePath(dir, top));
      if (owner === 'absent') continue; // A newer generation replaced it.
      if (owner === 'unreadable') return { heldBy: 'unidentified' };
      if (!(await ownerGone(dir, owner, thorough))) return { heldBy: owner };
      verbose(`Taking over lock ${dir}: holder PID ${owner.pid} is gone.`);
    }
    const mine = top + 1;
    try {
      await link(attempt.proposal, gatePath(dir, mine));
    } catch (error: unknown) {
      if (errnoCode(error) === 'EEXIST') continue;
      if (errnoCode(error) !== 'ENOENT') throw error;
      // Someone removed the lock directory by hand. Start over in a fresh one.
      await writeProposal(attempt);
      continue;
    }
    // A contender working from an old listing can only link a number below
    // the current top; the claim that counts is the highest.
    if ((await readGate(dir)).top > mine) {
      await remove(gatePath(dir, mine));
      continue;
    }
    await retire(dir, mine, token);
    return { generation: mine };
  }
  return { heldBy: 'contended' };
}

async function releaseGate(dir: string, generation: number, token: string): Promise<void> {
  const held = gatePath(dir, generation);
  const owner = (await readGate(dir)).top === generation ? await readRecord(held) : 'absent';
  if (typeof owner === 'string' || owner.token !== token) {
    warn(`Lock ${dir} changed hands while this process held it; leaving it alone.`);
    return;
  }
  // A second name for the same bytes: letting go needs no new data, even on a full disk.
  await link(held, `${held}.free`).catch((error: unknown) => {
    if (errnoCode(error) !== 'EEXIST') throw error;
  });
}

/** The shared holders of a lock. With `reap`, records of holders that are gone are removed. */
async function sharedHolders(
  dir: string,
  options: { thorough: boolean; reap: boolean }
): Promise<{ holders: OwnerRecord[]; unidentified: number }> {
  const holders: OwnerRecord[] = [];
  let unidentified = 0;
  for (const name of await names(dir)) {
    if (!name.startsWith('holder.')) continue;
    const path = join(dir, name);
    const owner = await readRecord(path);
    if (owner === 'absent') continue;
    if (owner === 'unreadable') unidentified += 1;
    else if (!(await ownerGone(dir, owner, options.thorough))) holders.push(owner);
    else if (options.reap) {
      verbose(`Removing shared hold of PID ${owner.pid} on ${dir}: the process is gone.`);
      await remove(path);
    }
  }
  holders.sort((a, b) =>
    a.requestedAt < b.requestedAt ? -1 : a.requestedAt > b.requestedAt ? 1 : 0
  );
  return { holders, unidentified };
}

interface Ticket {
  name: string;
  startedAt: number;
  pid: number;
}

function parseTicket(name: string): Ticket | undefined {
  const match = /^(\d+)-(\d+)-/.exec(name);
  return match === null ? undefined : { name, startedAt: Number(match[1]), pid: Number(match[2]) };
}

/** Arrival order: wait start first, then the name, so every reader agrees. */
function arrivedBefore(a: Ticket, b: Ticket): boolean {
  return a.startedAt !== b.startedAt ? a.startedAt < b.startedAt : a.name < b.name;
}

/**
 * The live queue. A ticket whose process is gone is removed; one that has
 * merely stopped being refreshed is skipped, since its owner may resume.
 */
async function readQueue(dir: string, self?: Ticket): Promise<{ depth: number; ahead: number }> {
  const waiters = join(dir, 'waiters');
  const now = Date.now();
  const live: Ticket[] = [];
  for (const name of await names(waiters).catch(() => [])) {
    const ticket = parseTicket(name);
    if (ticket === undefined) continue;
    if (name === self?.name) {
      live.push(ticket);
      continue;
    }
    const path = join(waiters, name);
    try {
      const text = await readTextIfExists(path);
      const recorded = text === undefined ? undefined : TicketRecord.validate(parseJson(text));
      const start = recorded?.ok === true ? recorded.value.start : undefined;
      const modified = (await pathInfo(path))?.mtimeMs;
      if (text === undefined || modified === undefined) continue;
      if (!isIdentityAlive({ pid: ticket.pid, start })) await remove(path);
      else if (now - modified <= TICKET_STALE_MS) live.push(ticket);
    } catch {
      // Left the queue between the listing and this read.
    }
  }
  const listed = self === undefined || live.some((ticket) => ticket.name === self.name);
  return {
    depth: live.length + (listed ? 0 : 1),
    ahead: self === undefined ? 0 : live.filter((ticket) => arrivedBefore(ticket, self)).length,
  };
}

/**
 * Takes a ticket. The tickets decide the grant: only the waiter with nobody
 * live ahead of it attempts the lock, so "you are next" is a promise. A queue
 * that cannot be written never fails an acquisition: the waiter then contends
 * without a place in line.
 */
async function joinQueue(
  dir: string,
  startedAt: number,
  start: string | undefined
): Promise<{ ticket: Ticket | undefined; heartbeat(): Promise<void>; leave(): Promise<void> }> {
  const name = `${startedAt}-${process.pid}-${randomId()}`;
  const path = join(dir, 'waiters', name);
  const content = JSON.stringify({ pid: process.pid, start });
  const write = (): Promise<void> => writeFile(path, content, { durable: false });
  try {
    await write();
  } catch (error: unknown) {
    verbose(`Could not join the queue for ${dir}: ${toError(error).message}`);
    const nothing = (): Promise<void> => Promise.resolve();
    return { ticket: undefined, heartbeat: nothing, leave: nothing };
  }
  let lastBeat = Date.now();
  return {
    ticket: { name, startedAt, pid: process.pid },
    async heartbeat() {
      if (Date.now() - lastBeat < TICKET_HEARTBEAT_MS) return;
      lastBeat = Date.now();
      // A rewrite, not a touch: it also recreates a ticket removed while this
      // process was stopped long enough to look dead.
      await write().catch(() => undefined);
    },
    async leave() {
      await remove(path).catch(() => undefined);
    },
  };
}

function describeHolders(status: { holders: readonly LockHolder[]; unidentified: number }): string {
  const { holders, unidentified } = status;
  const named = holders.map((holder) => {
    const details = Object.entries(holder.info).map(([key, value]) => `${key}=${value}`);
    return `PID ${holder.pid}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  });
  if (unidentified > 0) named.push(`${unidentified} unidentified process(es)`);
  return named.length === 0 ? '' : ` held by ${named.join(', ')}`;
}

function describeQueue(queue: { depth: number; ahead: number }): string {
  if (queue.depth <= 1 && queue.ahead === 0) return '';
  return queue.ahead === 0
    ? ` You are next in a queue of ${queue.depth} (granted in arrival order).`
    : ` ${queue.ahead} ahead of you in a queue of ${queue.depth} (granted in arrival order).`;
}

/** Locks this process holds, for the interrupt path and for process-group markers. */
const held = new Map<string, { dir: string; release: () => Promise<void> }>();
let hooked = false;

function hookProcess(): void {
  if (hooked) return;
  hooked = true;
  // `finally` does not run across `process.exit`, so an interrupted command
  // releases here. A lock that still escapes is taken over once its holder is gone.
  onShutdown('release', async () => {
    for (const lock of [...held.values()]) await lock.release().catch(() => undefined);
  });
  // Synchronous on purpose: the marker must exist before the group can outlive this process.
  onProcessGroup({
    started(pgid) {
      for (const [token, lock] of held) {
        try {
          writeFileSync(join(lock.dir, `group.${token}.${pgid}`), '');
        } catch (error: unknown) {
          verbose(
            `Could not record process group ${pgid} on ${lock.dir}: ${toError(error).message}`
          );
        }
      }
    },
    ended(pgid) {
      for (const [token, lock] of held) {
        try {
          rmSync(join(lock.dir, `group.${token}.${pgid}`), { force: true });
        } catch {
          // The marker goes with the lock's release at the latest.
        }
      }
    },
  });
}

async function removeGroupMarkers(dir: string, token: string): Promise<void> {
  for (const name of await names(dir)) {
    if (name.startsWith(`group.${token}.`)) await remove(join(dir, name));
  }
}

/** One acquisition in progress. */
interface Attempt {
  dir: string;
  token: string;
  /** Path of this acquisition's owner record, linked into place when it wins. */
  proposal: string;
  record: OwnerRecord;
  limit: number | undefined;
  /** The gate generation held right now, if any. */
  gate: number | undefined;
}

async function writeProposal(attempt: Attempt): Promise<void> {
  for (let round = 0; ; round += 1) {
    await ensureDir(attempt.dir);
    try {
      await writeFile(attempt.proposal, JSON.stringify(attempt.record), { durable: false });
      return;
    } catch (error: unknown) {
      // A removal of the lock directory still under way took it away again.
      if (errnoCode(error) !== 'ENOENT' || round >= GATE_ATTEMPTS) throw error;
    }
  }
}

/** What stands in the way of an acquisition. */
interface Blocked {
  holders: LockHolder[];
  unidentified: number;
  /** The obstacle is someone passing through the gate, gone in a moment. */
  passing?: boolean;
}

/** Tries once. Returns undefined when the lock is now held, otherwise what is in the way. */
async function attemptOnce(attempt: Attempt, thorough: boolean): Promise<Blocked | undefined> {
  const { dir, token } = attempt;
  if (attempt.gate === undefined) {
    const gate = await takeGate(attempt, thorough);
    if ('heldBy' in gate) {
      if (gate.heldBy === 'contended') return { holders: [], unidentified: 0, passing: true };
      if (gate.heldBy === 'unidentified') return { holders: [], unidentified: 1 };
      return { holders: [gate.heldBy], unidentified: 0, passing: gate.heldBy.mode === 'shared' };
    }
    attempt.gate = gate.generation;
  }
  const shared = await sharedHolders(dir, { thorough, reap: true });
  const count = shared.holders.length + shared.unidentified;
  if (attempt.record.mode === 'exclusive') {
    // Keep the gate while the shared holders finish: nobody new gets in.
    return count === 0 ? undefined : shared;
  }
  const generation = attempt.gate;
  attempt.gate = undefined;
  try {
    if (attempt.limit !== undefined && count >= attempt.limit) return shared;
    await link(attempt.proposal, join(dir, `holder.${token}`));
    return undefined;
  } finally {
    await releaseGate(dir, generation, token);
  }
}

function timeoutError(
  label: string,
  waitMs: number,
  blocked: Blocked,
  queue: { depth: number; ahead: number }
): FireForgeError {
  const waited =
    waitMs > 0 ? `Timed out after ${formatDuration(waitMs)} waiting for` : 'Could not take';
  return new FireForgeError(
    'lock-timeout',
    `${waited} the ${label} lock${describeHolders(blocked)}.${describeQueue(queue)}`,
    {
      exitCode: ExitCode.LOCK_TIMEOUT,
      hint: 'Wait for the other command to finish, or allow a longer wait with --wait-lock <seconds>.',
    }
  );
}

type Waiter = Awaited<ReturnType<typeof joinQueue>>;

/** Polls until the lock is held or the wait is over. Returns the queue ticket to give back. */
async function waitUntilHeld(
  attempt: Attempt,
  wait: { startedAt: number; waitMs: number; label: string }
): Promise<Waiter | undefined> {
  const { dir, record } = attempt;
  const { startedAt, waitMs, label } = wait;
  let waiter: Waiter | undefined;
  let pollMs = POLL_MIN_MS;
  let lastThorough = Number.NEGATIVE_INFINITY;
  let lastProgress = startedAt;
  try {
    // A newcomer that finds others queued lines up behind them instead of
    // racing them for the next free moment.
    if ((await readQueue(dir)).depth > 0) waiter = await joinQueue(dir, startedAt, record.start);
    for (;;) {
      const thorough = Date.now() - lastThorough >= THOROUGH_PROBE_MS;
      if (thorough) lastThorough = Date.now();
      const queue = await readQueue(dir, waiter?.ticket);
      // Only the head of the queue contends. Whoever already holds the gate
      // (an exclusive taker waiting out the shared holders) keeps going.
      const blocked =
        attempt.gate !== undefined || queue.ahead === 0
          ? await attemptOnce(attempt, thorough)
          : 'queued';
      if (blocked === undefined) return waiter;
      // A waiter further back did not look at the lock itself; look now, for the message.
      const inTheWay = async (): Promise<Blocked> =>
        blocked === 'queued' ? readLockStatus(dir) : blocked;
      if (Date.now() - startedAt >= waitMs) {
        throw timeoutError(label, waitMs, await inTheWay(), queue);
      }
      waiter ??= await joinQueue(dir, startedAt, record.start);
      await waiter.heartbeat();
      if (
        Date.now() - lastProgress >=
        (lastProgress === startedAt ? PROGRESS_FIRST_MS : PROGRESS_EVERY_MS)
      ) {
        lastProgress = Date.now();
        info(
          `Waiting for the ${label} lock${describeHolders(await inTheWay())}: ` +
            `${formatDuration(Date.now() - startedAt)} of up to ${formatDuration(waitMs)}.` +
            describeQueue(queue)
        );
      }
      const passing = blocked !== 'queued' && blocked.passing === true;
      await sleep(
        Math.max(1, Math.min(passing ? PASSING_POLL_MS : pollMs, startedAt + waitMs - Date.now()))
      );
      if (!passing) pollMs = Math.min(pollMs * 2, POLL_MAX_MS);
    }
  } catch (error: unknown) {
    await waiter?.leave();
    throw error;
  }
}

/**
 * Takes a lock, waiting in arrival order behind earlier waiters.
 *
 * @param path - The lock directory, created if absent
 * @param options - See {@link LockOptions}
 * @returns The held lock. The caller must release it
 * @throws A `lock-timeout` error (exit code 15) naming the holders when the wait expires
 */
export async function acquireLock(path: string, options: LockOptions = {}): Promise<HeldLock> {
  const token = randomId();
  const identity = await ownIdentity();
  const attempt: Attempt = {
    dir: path,
    token,
    proposal: join(path, `proposal.${process.pid}.${token}`),
    record: {
      pid: process.pid,
      ...(identity === undefined ? {} : { start: identity.start }),
      token,
      mode: options.mode ?? 'exclusive',
      requestedAt: new Date().toISOString(),
      info: { ...options.info },
    },
    limit: options.limit,
    gate: undefined,
  };
  await writeProposal(attempt);
  hookProcess();
  let acquired = false;
  try {
    const waiter = await waitUntilHeld(attempt, {
      startedAt: Date.now(),
      waitMs: options.waitMs ?? 30_000,
      label: options.label ?? path,
    });
    acquired = true;
    await waiter?.leave();
  } finally {
    await remove(attempt.proposal).catch(() => undefined);
    if (!acquired && attempt.gate !== undefined) await releaseGate(path, attempt.gate, token);
  }

  const gate = attempt.gate;
  let released: Promise<void> | undefined;
  const lock: HeldLock = {
    path,
    release() {
      released ??= (async (): Promise<void> => {
        held.delete(token);
        if (gate === undefined) await remove(join(path, `holder.${token}`));
        else await releaseGate(path, gate, token);
        await removeGroupMarkers(path, token);
      })();
      return released;
    },
  };
  held.set(token, { dir: path, release: () => lock.release() });
  return lock;
}

/**
 * Takes a lock only if it is free right now.
 *
 * @param path - The lock directory
 * @param options - See {@link LockOptions}; `waitMs` is ignored
 * @returns The held lock, or undefined when someone else holds it
 */
export async function tryAcquireLock(
  path: string,
  options: LockOptions = {}
): Promise<HeldLock | undefined> {
  try {
    return await acquireLock(path, { ...options, waitMs: 0 });
  } catch (error: unknown) {
    if (error instanceof FireForgeError && error.code === 'lock-timeout') return undefined;
    throw error;
  }
}

/**
 * Runs `body` while holding a lock, and releases it however `body` ends.
 *
 * @param path - The lock directory
 * @param options - See {@link LockOptions}
 * @param body - The work to do under the lock
 */
export async function withLock<T>(
  path: string,
  options: LockOptions,
  body: () => Promise<T>
): Promise<T> {
  const lock = await acquireLock(path, options);
  try {
    return await body();
  } finally {
    await lock.release();
  }
}

/**
 * Reports who holds a lock and how many wait, without taking or changing anything.
 *
 * @param path - The lock directory; a missing one reads as free
 */
export async function readLockStatus(path: string): Promise<LockStatus> {
  const shared = await sharedHolders(path, { thorough: false, reap: false });
  const holders = [...shared.holders];
  let unidentified = shared.unidentified;
  const gate = await readGate(path);
  if (!gate.free) {
    const owner = await readRecord(gatePath(path, gate.top));
    if (owner === 'unreadable') unidentified += 1;
    // A shared holder is in the gate only for the instant it registers.
    else if (
      owner !== 'absent' &&
      owner.mode === 'exclusive' &&
      !(await ownerGone(path, owner, false))
    ) {
      holders.unshift(owner);
    }
  }
  return {
    holders: holders.map(({ pid, mode, requestedAt, info: details }) => ({
      pid,
      mode,
      requestedAt,
      info: details,
    })),
    unidentified,
    waiting: (await readQueue(path)).depth,
  };
}
