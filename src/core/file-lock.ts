// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { LockContentionError } from '../errors/base.js';
import { getNodeErrorCode, isProcessAlive, toError } from '../utils/errors.js';
import { ensureDir } from '../utils/fs.js';
import { verbose, warn } from '../utils/logger.js';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_POLL_MS = 50;
const DEFAULT_STALE_LOCK_MS = 5 * 60_000;

/**
 * Minimum interval between stale-lock probes while a waiter polls. Probing
 * exactly once per waiter means a holder that dies *after* that probe leaves
 * the waiter polling a permanently dead lock until `timeoutMs` — up to 24
 * hours for the build lock (see `withBuildLock` in mach.ts). Re-probing on a
 * small interval bounds that to seconds while keeping the per-poll cost
 * negligible: one stat plus one small read every ~5 s.
 */
const STALE_REPROBE_INTERVAL_MS = 5_000;

/**
 * Default interval between wait probes (holder + queue) when a caller wants
 * deadline extension but no progress line of its own.
 */
const WAIT_PROBE_INTERVAL_MS = 5_000;

/**
 * Snapshot of the current lock holder handed to {@link FileLockOptions.onWaitProgress}.
 * `metadata` carries the pid file's human-diagnostic lines (line 3 onward,
 * e.g. `command=build`, `started=…`) written via
 * {@link FileLockOptions.ownerMetadata}.
 */
export interface LockHolder {
  pid: number;
  alive: boolean;
  metadata: string[];
}

/**
 * Live queue state around a contended lock.
 *
 * The lock itself behaves correctly under several concurrent sessions; the
 * gap this closes is VISIBILITY. Waiters advertise themselves in a sibling
 * directory so both the wait output and `fireforge status --lock` can say
 * how many are queued and how many are ahead of you.
 */
export interface LockQueueState {
  /** Live waiters currently queued for the lock, including this process. */
  depth: number;
  /** Live waiters that started waiting BEFORE this process. */
  ahead: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  /**
   * When set, the poll interval doubles after every contended poll (starting
   * from `pollMs`) up to this cap. When absent, polling stays at the fixed
   * `pollMs` interval — zero behavior change for existing callers.
   */
  pollMaxMs?: number;
  staleMs?: number;
  /**
   * Interval between stale-lock probes while waiting (defaults to
   * {@link STALE_REPROBE_INTERVAL_MS}). Exists mainly so tests can exercise
   * the mid-wait reaping path without multi-second sleeps.
   */
  staleReprobeMs?: number;
  /**
   * Interval between {@link onWaitProgress} callbacks while the lock is
   * contended. Progress reporting is off unless both this and
   * `onWaitProgress` are set.
   */
  waitProgressMs?: number;
  /**
   * Invoked roughly every `waitProgressMs` while waiting for a contended
   * lock. `holder` is `undefined` when the owner PID file is missing or
   * unreadable.
   */
  onWaitProgress?: (progress: {
    waitedMs: number;
    timeoutMs: number;
    holder: LockHolder | undefined;
    /** Queue state at this poll, when the waiter registry is available. */
    queue?: LockQueueState | undefined;
  }) => void;
  /**
   * When set, a wait whose QUEUE POSITION is still improving is granted a
   * fresh `timeoutMs` budget on each advance, up to `maxWaitMs` total.
   *
   * A fixed wall-clock budget against a queue whose depth the tool knows is
   * the wrong shape under several concurrent sessions: a wait that expires
   * one position from the head pays the entire wait and gets nothing. The
   * distinction that matters is not "how long have I waited" but "is this
   * queue moving" — a stalled queue still starves on the original budget,
   * which is the case the timeout exists for.
   *
   * Requires the waiter registry (see {@link LockQueueState}); a lock with
   * no readable queue never extends, because nothing observed an advance.
   */
  extendWhileAdvancing?: { maxWaitMs: number };
  /**
   * Invoked when {@link extendWhileAdvancing} actually grants an extension.
   *
   * Separate from {@link onWaitProgress} on purpose: an extension is the one
   * moment the budget the operator asked for stops being the budget in
   * force, and a wait that silently outlives its stated timeout is
   * indistinguishable from a broken one. `budgetMs` is the new TOTAL budget
   * measured from the start of the wait, so it can be compared directly
   * against the requested figure.
   */
  onWaitExtended?: (extension: { ahead: number; budgetMs: number }) => void;
  onTimeoutMessage?: string;
  onStaleLockMessage?: (ageMs: number) => string | undefined;
  /** Extra owner-file lines for human diagnostics; ignored by lock mechanics. */
  ownerMetadata?: readonly string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Derives the sibling lock-directory path used to guard a file-based resource. */
export function createSiblingLockPath(filePath: string, suffix = '.fireforge.lock'): string {
  return `${filePath}${suffix}`;
}

/**
 * Filename of a lock directory's owner record, relative to the lock dir.
 *
 * Exported so external readers (`tree-store.ts`) share the constant instead of
 * re-spelling `'pid'`; the file *format* is documented on {@link readLockOwner}.
 */
export const LOCK_PID_FILE = 'pid';

/**
 * Owner record read back from a lock directory's PID file.
 *
 * `token` is the per-acquisition UUID written on line 2 of the PID file. A
 * lock whose owner-file write failed has `token: undefined`; readers must
 * treat that as "unknown owner instance", not as a mismatch.
 */
type LockOwner =
  { present: false } | { present: true; pid: number; token?: string; metadata: string[] };

/**
 * Reads the owner PID (line 1), acquisition token (line 2), and diagnostic
 * metadata (lines 3+, see {@link FileLockOptions.ownerMetadata}) from a lock
 * directory's PID file. Returns `{ present: false }` when the PID file is
 * missing or the PID does not parse as a finite integer (caller falls back
 * to the age-only staleness heuristic).
 *
 * File format note: external readers do `parseInt(content.trim(), 10)`,
 * which parses the leading digits of a multi-line file — so the token line
 * stays compatible.
 */
async function readLockOwner(lockPath: string): Promise<LockOwner> {
  try {
    const pidContent = await readFile(join(lockPath, LOCK_PID_FILE), 'utf-8');
    const [pidLine, tokenLine, ...metadataLines] = pidContent.split('\n');
    const pid = parseInt((pidLine ?? '').trim(), 10);
    if (Number.isFinite(pid)) {
      const metadata = metadataLines.map((line) => line.trim()).filter((line) => line.length > 0);
      const token = tokenLine?.trim();
      if (token !== undefined && token.length > 0) {
        return { present: true, pid, token, metadata };
      }
      return { present: true, pid, metadata };
    }
  } catch {
    // PID file missing or unreadable — treat as absent.
  }
  return { present: false };
}

/** Sibling directory in which waiters advertise themselves. */
function lockWaitersDir(lockPath: string): string {
  return `${lockPath}.waiters`;
}

/** Parsed waiter-file name: `<startedAtMs>-<pid>-<uuid>`. */
function parseWaiterFileName(name: string): { startedAt: number; pid: number } | undefined {
  const match = /^(\d+)-(\d+)-/.exec(name);
  const startedAt = match?.[1];
  const pid = match?.[2];
  if (startedAt === undefined || pid === undefined) return undefined;
  return { startedAt: Number.parseInt(startedAt, 10), pid: Number.parseInt(pid, 10) };
}

/**
 * Reads the live waiter queue around `lockPath`, dropping entries whose
 * process is gone (a killed waiter must not inflate the depth forever).
 *
 * Advisory and fail-open: an unreadable registry reports an empty queue
 * rather than failing whatever asked.
 *
 * @param lockPath - The lock directory whose queue to inspect
 * @param selfStartedAt - This process's wait start, to compute `ahead`
 */
export async function readLockQueue(
  lockPath: string,
  selfStartedAt?: number
): Promise<LockQueueState> {
  let names: string[];
  try {
    names = await readdir(lockWaitersDir(lockPath));
  } catch {
    return { depth: 0, ahead: 0 };
  }
  const live = names
    .map(parseWaiterFileName)
    .filter((entry): entry is { startedAt: number; pid: number } => entry !== undefined)
    .filter((entry) => isProcessAlive(entry.pid));
  const ahead =
    selfStartedAt === undefined
      ? 0
      : live.filter((entry) => entry.startedAt < selfStartedAt).length;
  return { depth: live.length, ahead };
}

/**
 * Snapshot of a lock for `fireforge status --lock`: who holds
 * it, for how long, and how deep the queue behind it is.
 */
export interface LockStatusSnapshot {
  held: boolean;
  holder?: LockHolder | undefined;
  /** Milliseconds since the lock directory was created, when held. */
  heldForMs?: number | undefined;
  queueDepth: number;
}

/**
 * Inspects a lock without acquiring it. Read-only and fail-open: a missing
 * lock is reported as free, never as an error.
 */
export async function readLockStatus(lockPath: string): Promise<LockStatusSnapshot> {
  const queue = await readLockQueue(lockPath);
  let heldForMs: number | undefined;
  try {
    // Clamped: filesystem mtime resolution can round a just-created lock
    // fractionally ahead of `Date.now()`, and a negative age is nonsense
    // in a status report.
    heldForMs = Math.max(0, Date.now() - (await stat(lockPath)).mtimeMs);
  } catch {
    return { held: false, queueDepth: queue.depth };
  }
  const owner = await readLockOwner(lockPath);
  const holder: LockHolder | undefined = owner.present
    ? { pid: owner.pid, alive: isProcessAlive(owner.pid), metadata: owner.metadata }
    : undefined;
  return { held: true, holder, heldForMs, queueDepth: queue.depth };
}

/**
 * Registers this process in the lock's waiter queue. Returns a
 * deregistration function that is always safe to call (including when
 * registration itself failed).
 */
async function registerWaiter(lockPath: string, startedAt: number): Promise<() => Promise<void>> {
  const dir = lockWaitersDir(lockPath);
  const file = join(dir, `${String(startedAt)}-${String(process.pid)}-${randomUUID()}`);
  try {
    await ensureDir(dir);
    await writeFile(file, `${String(process.pid)}\n`, 'utf-8');
  } catch (error: unknown) {
    // Advisory only — never fail a lock acquisition over the queue display.
    verbose(`Could not register lock waiter for ${lockPath}: ${toError(error).message}`);
    return async (): Promise<void> => {
      /* nothing to remove */
    };
  }
  return async (): Promise<void> => {
    await rm(file, { force: true });
  };
}

/**
 * Reads the contended lock's owner and queue in one go. One probe per cycle
 * serves both the progress line and the deadline extension, so the two can
 * never disagree about the position they saw. Failure to read the owner
 * degrades to `holder: undefined` — a diagnostic must never break the wait
 * loop.
 */
async function probeWaitState(
  lockPath: string,
  startedAt: number
): Promise<{ holder: LockHolder | undefined; queue: LockQueueState }> {
  const owner = await readLockOwner(lockPath);
  const holder: LockHolder | undefined = owner.present
    ? { pid: owner.pid, alive: isProcessAlive(owner.pid), metadata: owner.metadata }
    : undefined;
  return { holder, queue: await readLockQueue(lockPath, startedAt) };
}

/**
 * Reaps a lock directory believed to be stale, safely against concurrent
 * reapers and a concurrent legitimate re-acquisition.
 *
 * A naive stat → read-PID → `rm` sequence has a TOCTOU hole: two waiters
 * both observe the dead owner, one removes the stale dir and `mkdir`s its
 * own lock, and the other's already-decided `rm` then deletes the *fresh*
 * lock — two processes inside the critical section at once.
 *
 * Rename-aside closes it: `rename()` is atomic, so exactly one reaper wins
 * ownership of the directory (the loser gets ENOENT and re-polls), and
 * nothing ever deletes the live path directly. After winning the rename the
 * owner is re-read from the renamed dir — if it is now a *live* process (the
 * lock was released and re-acquired between the staleness read and the
 * rename), it is renamed back instead of reaped.
 *
 * @returns true when the caller should immediately retry `mkdir` (the lock
 *   path is now free or was freed by someone else), false when the lock is
 *   legitimately held and the caller should keep waiting.
 */
async function reapStaleLock(
  lockPath: string,
  ageMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  const reapPath = `${lockPath}.reaping-${String(process.pid)}-${randomUUID()}`;
  try {
    await rename(lockPath, reapPath);
  } catch (error: unknown) {
    if (getNodeErrorCode(error) === 'ENOENT') {
      // Another reaper won, or the owner released — either way, retry mkdir.
      verbose(`Stale lock disappeared before reaping completed: ${lockPath}`);
      return true;
    }
    verbose(`Could not rename stale lock aside (${lockPath}): ${toError(error).message}`);
    return false;
  }

  // We exclusively own reapPath now. Re-verify: the owner may have changed
  // between the staleness probe and the rename (release + fresh acquire).
  const owner = await readLockOwner(reapPath);
  if (owner.present && isProcessAlive(owner.pid)) {
    try {
      await rename(reapPath, lockPath);
      verbose(
        `Aborted stale-lock reap of ${lockPath}: owner PID ${String(owner.pid)} is alive (lock was re-acquired mid-probe)`
      );
    } catch (restoreError: unknown) {
      // Rename-back can only fail if a third process mkdir'd the lock path
      // in this instant. The displaced live owner keeps running without its
      // lock — surface it loudly instead of hiding the lost exclusion.
      warn(
        `Could not restore live lock for PID ${String(owner.pid)} at ${lockPath} ` +
          `(${toError(restoreError).message}). Displaced lock kept at ${reapPath} for inspection.`
      );
    }
    return false;
  }

  const staleMessage = onStaleLockMessage?.(ageMs);
  if (staleMessage) {
    warn(staleMessage);
  } else {
    verbose(`Removing stale lock ${lockPath} (age: ${Math.round(ageMs / 1000)}s)`);
  }
  await rm(reapPath, { recursive: true, force: true });
  return true;
}

/**
 * Probes a contended lock for staleness and reaps it when the owner is gone.
 *
 * @returns true when the caller should immediately retry `mkdir`.
 */
async function removeIfStaleLock(
  lockPath: string,
  staleMs: number,
  onStaleLockMessage?: (ageMs: number) => string | undefined
): Promise<boolean> {
  try {
    const lockStat = await stat(lockPath);
    const ageMs = Date.now() - lockStat.mtimeMs;

    // Check PID FIRST, independent of age. Age-gating everything means a
    // lock younger than `staleMs` (default 5 minutes) is never removed even
    // when its PID file points at a process that has already exited — the
    // situation after SIGINT'ing `furnace preview`, where the signal handler
    // calls `process.exit` and `withFileLock`'s release never runs. With the
    // PID-first check an explicitly-dead owner unblocks immediately.
    const owner = await readLockOwner(lockPath);
    if (owner.present) {
      if (!isProcessAlive(owner.pid)) {
        return await reapStaleLock(lockPath, ageMs, onStaleLockMessage);
      }
      // PID is alive — respect it regardless of age. A slow `mach build`
      // legitimately holds the lock past the stale threshold and we don't
      // want to race-remove it.
      verbose(
        `Lock at ${lockPath} is ${Math.round(ageMs / 1000)}s old but PID ${String(owner.pid)} is still running — not removing`
      );
      return false;
    }

    // No readable PID file. Fall back to the age-only heuristic so locks
    // written by earlier FireForge releases (which may not have written a
    // PID file) still clear after the staleness window elapses.
    if (ageMs <= staleMs) {
      return false;
    }

    return await reapStaleLock(lockPath, ageMs, onStaleLockMessage);
  } catch (error: unknown) {
    const code = getNodeErrorCode(error);
    if (code === 'ENOENT') {
      verbose(`Stale lock disappeared before cleanup completed: ${lockPath}`);
      return true;
    }

    verbose(`Stale lock check failed for ${lockPath}: ${toError(error).message}`);
    throw toError(error);
  }
}

/**
 * Releases a lock previously acquired by this process, verifying ownership
 * first. An unconditional `finally { rm }` would remove *whichever* lock
 * directory is present — if a stale-lock reaper had (in a pathological race)
 * replaced our lock, that deletes the new owner's lock and compounds the
 * double-acquisition. When the PID file no longer names us, warn and leave
 * the directory alone.
 *
 * `ownerFileWritten` is false when our own owner-file write failed at
 * acquisition (non-fatal there); ownership then cannot be verified and the
 * removal is unconditional, which is strictly better than leaking the lock.
 */
async function releaseLock(
  lockPath: string,
  ownerToken: string,
  ownerFileWritten: boolean
): Promise<void> {
  if (ownerFileWritten) {
    const owner = await readLockOwner(lockPath);
    if (
      owner.present &&
      (owner.pid !== process.pid || (owner.token !== undefined && owner.token !== ownerToken))
    ) {
      warn(
        `Not removing lock ${lockPath}: it is now owned by PID ${String(owner.pid)} — ` +
          'this process no longer holds it.'
      );
      return;
    }
  }
  await rm(lockPath, { recursive: true, force: true });
}

/**
 * Removes a lock directory only if this process still owns it, for callers
 * that hold no acquisition token.
 *
 * The ownership half of {@link releaseLock}, minus the token check — a
 * signal-time sweeper knows which lock paths its own operations opened, but
 * not the per-acquisition UUID those acquisitions minted. The PID check is
 * still the one that matters: it stops the sweeper deleting a lock a
 * DIFFERENT process acquired in the window between our operation dying and
 * the sweep running.
 *
 * Never throws: callers are shutdown paths where a slow or failing I/O must
 * not prevent the process from exiting. Returns whether the directory was
 * removed so callers can log accurately.
 *
 * @param lockPath - Lock directory to remove
 * @returns True when the lock was removed, false when it was left in place
 */
export async function releaseLockIfOwned(lockPath: string): Promise<boolean> {
  try {
    const owner = await readLockOwner(lockPath);
    if (owner.present && owner.pid !== process.pid) {
      return false;
    }
    await rm(lockPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the contention refusal thrown when the wait budget expires.
 *
 * Typed as {@link LockContentionError} (a `FireForgeError`) so the CLI
 * boundary prints the refusal as one clean line instead of an "Unexpected
 * error" stack. Callers supplying `onTimeoutMessage` still get the holder
 * identification appended — the reason-first copy stays theirs, the "who
 * holds it" is ours.
 */
async function buildLockTimeoutError(
  lockPath: string,
  onTimeoutMessage: string | undefined,
  cause: unknown,
  queue?: LockQueueState
): Promise<LockContentionError> {
  const owner = await readLockOwner(lockPath);
  const liveHolder = owner.present && isProcessAlive(owner.pid) ? owner : undefined;
  const details =
    liveHolder !== undefined && liveHolder.metadata.length > 0
      ? ` (${liveHolder.metadata.join(', ')})`
      : '';
  const position = formatQueuePositionReached(queue);
  if (onTimeoutMessage !== undefined) {
    const identifiedHolder =
      liveHolder !== undefined
        ? ` The lock is held by PID ${String(liveHolder.pid)}${details}.`
        : '';
    return new LockContentionError(`${onTimeoutMessage}${identifiedHolder}${position}`, cause);
  }
  const holderHint =
    liveHolder !== undefined
      ? ` It is held by running process ${String(liveHolder.pid)}${details} — wait for it to finish, or stop it and retry.`
      : ' If no other FireForge process is running, remove the lock directory and retry.';
  return new LockContentionError(
    `Timed out waiting for file lock ${lockPath}.${holderHint}${position}`,
    cause
  );
}

/**
 * States the queue position the expired wait actually reached.
 *
 * Silence here is what made the worst outcome invisible: a wait that expires
 * one position from the head has paid the whole budget for nothing, and the
 * operator cannot tell that from a queue that never moved. Naming the
 * position turns "raise the budget" into an informed decision instead of a
 * guess. Omitted when no queue was observed — an empty registry is not
 * evidence of an empty queue.
 */
function formatQueuePositionReached(queue: LockQueueState | undefined): string {
  if (queue === undefined || queue.depth === 0) return '';
  if (queue.ahead === 0) {
    return ` You were next in a queue of ${String(queue.depth)} when the wait expired — a larger --wait-lock would very likely have got a turn.`;
  }
  return ` You were still ${String(queue.ahead)} from the head of a queue of ${String(queue.depth)} when the wait expired; re-run with a larger --wait-lock.`;
}

/**
 * Runs one wait probe: reads holder and queue, and reports progress when the
 * caller asked for it. Split out of the wait loop so the loop stays a
 * readable state machine.
 */
async function runWaitProbe(
  lockPath: string,
  startedAt: number,
  timeoutMs: number,
  options: FileLockOptions
): Promise<{ queue: LockQueueState }> {
  const { holder, queue } = await probeWaitState(lockPath, startedAt);
  options.onWaitProgress?.({
    waitedMs: Date.now() - startedAt,
    timeoutMs,
    holder,
    queue,
  });
  return { queue };
}

/**
 * Lock directories this process currently holds.
 *
 * `withFileLock`'s `finally` never runs across a `process.exit`, so a
 * SIGTERM'd command leaves its lock on disk. The next contender reclaims it
 * immediately (the PID-first staleness check sees a dead owner), but in the
 * window between, `fireforge status --lock` reports the lock held by a
 * process that is not running — which is exactly the question an operator
 * asks after a kill. The signal sweep closes that window.
 *
 * Paths only: the per-acquisition token lives in `withFileLock`'s frame and
 * a sweeper cannot see it. {@link releaseLockIfOwned} checks the PID, which
 * is the check that matters — it stops the sweep deleting a lock a
 * DIFFERENT process acquired in the meantime.
 */
const heldLocks = new Set<string>();

/**
 * Releases every lock this process still holds, for the signal path.
 *
 * Never throws and never rejects: a shutdown path must not be able to keep
 * the process alive. Returns the paths actually removed so the caller can
 * report accurately.
 */
export async function forceReleaseHeldLocksForSignal(): Promise<string[]> {
  const paths = [...heldLocks];
  const removed: string[] = [];
  for (const lockPath of paths) {
    heldLocks.delete(lockPath);
    if (await releaseLockIfOwned(lockPath)) {
      removed.push(lockPath);
    }
  }
  return removed;
}

/** Runs an async operation while holding a directory lock, with stale-lock recovery. */
export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_LOCK_MS;
  const staleReprobeMs = options.staleReprobeMs ?? STALE_REPROBE_INTERVAL_MS;
  const startedAt = Date.now();
  const extend = options.extendWhileAdvancing;
  const hardDeadline = extend !== undefined ? startedAt + extend.maxWaitMs : undefined;
  let deadline = startedAt + timeoutMs;
  let lastStaleProbeAt: number | undefined;
  let currentPollMs = pollMs;
  let lastProbeAt = startedAt;
  /** Best (lowest) queue position seen so far; used to detect an advance. */
  let bestAhead: number | undefined;
  /** Last observed queue state, so the timeout refusal can name the position reached. */
  let lastQueue: LockQueueState | undefined;
  /** Set on first contention so an uncontended acquire costs nothing. */
  let deregisterWaiter: (() => Promise<void>) | undefined;

  // One cadence drives both the progress line and the deadline extension.
  // Either feature alone is enough to want the probe; neither is worth a
  // second timer.
  const probeIntervalMs = options.waitProgressMs ?? WAIT_PROBE_INTERVAL_MS;
  const probeWanted =
    (options.onWaitProgress !== undefined && options.waitProgressMs !== undefined) ||
    extend !== undefined;

  await ensureDir(dirname(lockPath));

  try {
    for (;;) {
      try {
        await mkdir(lockPath);
        break;
      } catch (error: unknown) {
        if (getNodeErrorCode(error) !== 'EEXIST') {
          throw error;
        }

        // Advertise this waiter so the queue is visible to the wait output
        // and to `fireforge status --lock`. Registered lazily:
        // an uncontended acquisition never touches the registry.
        deregisterWaiter ??= await registerWaiter(lockPath, startedAt);

        if (lastStaleProbeAt === undefined || Date.now() - lastStaleProbeAt >= staleReprobeMs) {
          lastStaleProbeAt = Date.now();
          if (await removeIfStaleLock(lockPath, staleMs, options.onStaleLockMessage)) {
            continue;
          }
        }

        if (Date.now() >= deadline) {
          throw await buildLockTimeoutError(lockPath, options.onTimeoutMessage, error, lastQueue);
        }

        if (probeWanted && Date.now() - lastProbeAt >= probeIntervalMs) {
          lastProbeAt = Date.now();
          // Report the budget that is CURRENTLY in force, not the one
          // originally requested: once an extension has been granted, the
          // requested figure is stale, and a progress line that keeps
          // quoting it reads as a timeout that does not fire.
          const probe = await runWaitProbe(lockPath, startedAt, deadline - startedAt, options);
          lastQueue = probe.queue;
          // An advance — someone ahead of us took their turn and finished —
          // buys a fresh budget, because the wait is working. Only a queue
          // that stops moving starves, which is the case the timeout is for.
          //
          // The FIRST observation is a seed, never an advance. `bestAhead`
          // used to start `undefined`, so the opening probe always satisfied
          // this test and handed out a free full budget: a `--wait-lock 300`
          // run outlived its 300 s even against a queue that never moved
          // once, which is exactly the "it does not reliably give up after N
          // seconds" a downstream fork reported.
          if (hardDeadline !== undefined) {
            if (bestAhead === undefined) {
              bestAhead = probe.queue.ahead;
            } else if (probe.queue.ahead < bestAhead) {
              bestAhead = probe.queue.ahead;
              deadline = Math.min(Date.now() + timeoutMs, hardDeadline);
              options.onWaitExtended?.({
                ahead: probe.queue.ahead,
                budgetMs: deadline - startedAt,
              });
            }
          }
        }

        await sleep(currentPollMs);
        if (options.pollMaxMs !== undefined) {
          currentPollMs = Math.min(currentPollMs * 2, options.pollMaxMs);
        }
      }
    }
  } finally {
    // Leaving the queue happens the moment we stop waiting — whether we
    // acquired the lock or timed out.
    await deregisterWaiter?.();
  }

  // Stamp ownership (PID + per-acquisition token) into the lock directory so
  // stale-lock recovery can check liveness and release can verify the lock
  // is still ours before removing it.
  const ownerToken = randomUUID();
  let ownerFileWritten = false;
  try {
    const metadata =
      options.ownerMetadata
        ?.map((line) => line.replace(/\r?\n/g, ' ').trim())
        .filter((line) => line.length > 0) ?? [];
    await writeFile(
      join(lockPath, LOCK_PID_FILE),
      `${String(process.pid)}\n${ownerToken}\n${metadata.length > 0 ? `${metadata.join('\n')}\n` : ''}`,
      'utf-8'
    );
    ownerFileWritten = true;
  } catch {
    // Non-fatal: stale recovery falls back to age-only heuristic and release
    // falls back to unconditional removal.
  }

  heldLocks.add(lockPath);
  try {
    return await operation();
  } finally {
    heldLocks.delete(lockPath);
    await releaseLock(lockPath, ownerToken, ownerFileWritten);
  }
}
