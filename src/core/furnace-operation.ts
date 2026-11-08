// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { FurnacePendingRepairOperation } from '../types/furnace.js';
import { assert } from '../utils/assert.js';
import { toError } from '../utils/errors.js';
import { verbose, warn } from '../utils/logger.js';
import { sessionWaitLockMs } from '../utils/options.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { readLockStatus, releaseLockIfOwned, withFileLock } from './file-lock.js';
import { loadFurnaceState, updateFurnaceState } from './furnace-config.js';
import {
  restoreRollbackJournal,
  restoreRollbackJournalOrThrow,
  type RollbackJournal,
  trackRollbackMutations,
} from './furnace-rollback.js';

/** Sidecar lock filename used to serialize concurrent furnace mutations. */
const FURNACE_LOCK_FILENAME = 'furnace.lock';

/**
 * The signal names the lifecycle wrapper knows how to react to. Spelled out
 * as a literal union (rather than `NodeJS.Signals`) so the public type
 * surface does not depend on the NodeJS global namespace. Consumers of
 * FireForge's published scoped npm package may compile against tsconfigs
 * that omit `@types/node`.
 */
export type FurnaceShutdownSignal = 'SIGINT' | 'SIGTERM';

/**
 * Context handed to a furnace mutation body so it can register the in-flight
 * rollback journal with the lifecycle wrapper. The wrapper uses the registered
 * journal to perform rollback when the process receives SIGINT/SIGTERM mid-run.
 */
export interface FurnaceOperationContext {
  /**
   * Registers the rollback journal for the current unit of work. Must be
   * called once the body has constructed its journal so the signal handler
   * can find it. Calling again starts a new unit: it replaces the prior
   * journal and re-arms the rollback latch, so a mutation made of several
   * independent units (a named deploy of several components) restores each
   * unit's journal once.
   */
  registerJournal(journal: RollbackJournal): void;
  /**
   * Declares that the registered unit committed, so a later failure or signal
   * in the same mutation does not restore its files. Callers invoke it right
   * after the unit's state is durably persisted.
   */
  commitJournal(): void;
  /**
   * Registers an extra cleanup callback to run during signal-driven teardown
   * in addition to the journal restore. Used by `furnace preview` to make
   * sure `cleanStories` runs even when the user hits Ctrl+C mid-run. The
   * callback should be best-effort and idempotent: cleanup errors are
   * collected, not re-thrown.
   */
  registerCleanup(cleanup: () => Promise<void>): void;
  /**
   * Declares that the body has already restored its own journal, so the
   * wrapper's throw-path rollback must not restore it a second time.
   *
   * Bodies that catch-and-restore on their own call this from their catch
   * block after the restore, then re-throw, so the wrapper does not restore
   * the same journal a second time and race a second `pendingRepair` write
   * against the state-file lock.
   */
  markRolledBack(): void;
  /** Registers and joins the actual restore, including signal-driven shutdown. */
  runRollback?(restore: () => Promise<void>): Promise<void>;
}

/** Options for `runFurnaceMutation`. */
export interface RunFurnaceMutationOptions {
  /**
   * If true, skip lock acquisition and signal-handler installation entirely.
   * Used by dry-run paths where no engine mutation occurs.
   *
   * Note: a dry-run can overlap with a real mutation because it does not
   * acquire the lock. This is safe because dry-runs only read. However, a
   * dry-run that starts before a real mutation and finishes after it may
   * observe partially-written engine state. Accept this trade-off so that
   * concurrent dry-runs never block each other or a real apply.
   */
  dryRun?: boolean;
  /**
   * Override the default 30 s furnace-lock timeout.
   *
   * Set from the caller's resolved `--wait-lock` budget, so one flag governs
   * both locks a furnace mutation takes (the engine session lock and this
   * one). Every furnace leaf that takes this lock threads its `--wait-lock`
   * here. When absent, {@link sessionWaitLockMs} supplies the session-wide
   * budget (`FIREFORGE_WAIT_LOCK`).
   */
  lockTimeoutMs?: number;
  /**
   * If true, skip the pendingRepair pre-flight check. Used by `doctor
   * --repair-furnace` which must be able to mutate the engine even when a
   * pendingRepair marker is set.
   */
  skipPendingRepairCheck?: boolean;
}

/**
 * Converts a resolved `--wait-lock` budget in seconds into the
 * {@link RunFurnaceMutationOptions} slice that applies it to the furnace
 * lock. Undefined in, empty out, so the caller can spread it
 * unconditionally without assigning `undefined` under
 * `exactOptionalPropertyTypes`.
 *
 * One helper owns the seconds-to-milliseconds conversion.
 *
 * @param waitLockSeconds - Resolved budget in seconds, or undefined
 * @returns `{ lockTimeoutMs }`, or `{}` when no budget applies
 */
export function waitLockMutationOptions(
  waitLockSeconds: number | undefined
): Pick<RunFurnaceMutationOptions, 'lockTimeoutMs'> {
  return waitLockSeconds === undefined ? {} : { lockTimeoutMs: waitLockSeconds * 1000 };
}

/**
 * Module-scoped registry of in-flight furnace operations. Indexed by an
 * incrementing token so multiple nested mutations (e.g. preview wrapping
 * apply) each get their own slot, though in practice the apply-wide lock
 * means only one slot is active at any time per process.
 */
interface ActiveFurnaceOperation {
  root: string;
  kind: FurnacePendingRepairOperation;
  journal?: RollbackJournal;
  cleanups: Array<() => Promise<void>>;
  /** Set to true when the body has completed successfully. The signal handler
   *  checks this flag so it doesn't roll back an already-committed mutation if
   *  a signal arrives during the finally-block cleanup window. */
  completed?: boolean;
  /**
   * Rollback latch for the registered journal. The throw path and the signal
   * path can reach the same journal (a SIGINT landing mid-restore finds the
   * operation still active), so whichever starts the restore first records
   * its promise and the other joins it. `registerJournal`/`commitJournal`
   * clear a settled latch so the next unit restores independently.
   */
  rollbackState?: 'in-flight' | 'done';
  rollbackPromise?: Promise<void>;
  /** True while this operation's in-flight sidecar exists. */
  inflightRecorded?: boolean;
}

/**
 * Runs `restore` as the registered journal's rollback unless one already
 * ran or is running, in which case the existing one is returned. Stays
 * synchronous up to the latch update, which is what makes the claim atomic
 * against the signal handler.
 */
function rollbackOnce(op: ActiveFurnaceOperation, restore: () => Promise<void>): Promise<void> {
  if (op.rollbackPromise) return op.rollbackPromise;
  if (op.rollbackState === 'done') return Promise.resolve();
  op.rollbackState = 'in-flight';
  op.rollbackPromise = Promise.resolve()
    .then(restore)
    .finally(() => {
      op.rollbackState = 'done';
    });
  return op.rollbackPromise;
}

/** Re-arms the latch for a new unit; an in-flight restore keeps its claim. */
function rearmRollback(op: ActiveFurnaceOperation): void {
  if (op.rollbackState === 'in-flight') return;
  delete op.rollbackState;
  delete op.rollbackPromise;
}

const activeOperations = new Map<number, ActiveFurnaceOperation>();
let nextOperationToken = 1;
let signalRollbackInFlight = false;

/**
 * Returns true while a signal-driven rollback is in progress. The bin entry
 * point uses this as a re-entrancy guard so a user mashing Ctrl+C cannot
 * trigger a second rollback that races the first. Exposed for the bin shim
 * (and the test suite). Production callers should not need it.
 */
export function isSignalRollbackInFlight(): boolean {
  return signalRollbackInFlight;
}

/**
 * Rolls back every in-flight furnace operation and writes a pendingRepair
 * marker for each. The bin entry point installs SIGINT/SIGTERM handlers that
 * call this and then exit. Calling it directly from inside the library would
 * violate the "process.exit only in bin" invariant. The function is also
 * exposed under this name so the test suite can exercise the teardown path
 * without going through `process.emit` / `process.exit`.
 */
/** Maximum time (ms) the signal-driven rollback may take per operation. */
const SIGNAL_ROLLBACK_TIMEOUT_MS = 15_000;

/** Races a promise against a deadline, rejecting with a timeout error if the deadline expires. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

/**
 * Rolls back every in-flight furnace operation and writes a pendingRepair
 * marker for each. Each cleanup callback and journal restore is bounded by a
 * timeout so a stuck I/O operation cannot hang the process indefinitely.
 */
export async function rollbackActiveOperationsForSignal(
  signal: FurnaceShutdownSignal
): Promise<void> {
  // Snapshot the active operations so we don't race with `runFurnaceMutation`
  // clearing slots during normal completion. Filter completed bodies so a
  // body sitting in its finally-block cleanup window is not counted as live
  // work. Counting it would mis-trigger the rollback banner for plain
  // `fireforge run` (which never registers a mutation but can receive
  // SIGTERM).
  const snapshot = [...activeOperations.values()].filter((op) => !op.completed);

  if (snapshot.length === 0) {
    // Nothing to roll back. Stay silent so commands that never mutated (run,
    // watch, test, doctor) don't print an alarming "rolling back mutations"
    // line on Ctrl+C / SIGTERM. Leave `signalRollbackInFlight` false so a
    // subsequent registrant can still trigger the full path.
    return;
  }

  signalRollbackInFlight = true;
  warn(`Received ${signal}; rolling back in-flight furnace mutations…`);

  for (const op of snapshot) {
    await rollbackOperation(op, { kind: 'signal', signal });
  }
}

type RollbackCause = { kind: 'signal'; signal: FurnaceShutdownSignal } | { kind: 'throw' };

/**
 * Rolls back one operation for either cause, joining a restore a body-owned
 * path already started. The signal cause bounds the join and records a marker
 * when it fails; the throw cause never throws, because the body's own error is
 * what the operator needs to see.
 */
async function rollbackOperation(op: ActiveFurnaceOperation, cause: RollbackCause): Promise<void> {
  const joined = op.rollbackPromise !== undefined;
  const promise = rollbackOnce(op, () => restoreOperation(op, cause));
  if (!joined) {
    await promise;
  } else {
    try {
      await withTimeout(promise, SIGNAL_ROLLBACK_TIMEOUT_MS, 'In-flight rollback');
    } catch (error) {
      if (cause.kind === 'signal') {
        await persistPendingRepair(
          op.root,
          op.kind,
          `interrupted by ${cause.signal}; rollback incomplete: ${toError(error).message}`
        );
      }
    }
  }
  // An uncertain outcome has already written its own marker; the sidecar only
  // distinguishes a clean exit from a killed process.
  await clearInflightRecord(op);
}

/** Runs the cleanups, then restores the journal, recording a marker when the result is uncertain. */
async function restoreOperation(op: ActiveFurnaceOperation, cause: RollbackCause): Promise<void> {
  const cleanupErrors: string[] = [];
  const subject = cause.kind === 'signal' ? `interrupted by ${cause.signal}` : `${op.kind} failed`;

  // Cleanups run before the journal restore so the restore writes original
  // contents back over the tidiest possible tree.
  for (const cleanup of op.cleanups) {
    try {
      await withTimeout(cleanup(), SIGNAL_ROLLBACK_TIMEOUT_MS, 'Cleanup callback');
    } catch (error: unknown) {
      cleanupErrors.push(toError(error).message);
    }
  }

  const recordMarker = (reason: string): Promise<void> =>
    persistPendingRepair(op.root, op.kind, reason).catch((error: unknown) => {
      warn(`Could not persist pending-repair marker: ${toError(error).message}`);
    });

  if (!op.journal) {
    if (cause.kind === 'throw') {
      // A body that threw before registering a journal is overwhelmingly a
      // refusal raised during pre-flight, and marking the root as needing
      // repair would block every later furnace mutation behind a `doctor
      // --repair-furnace` that has nothing to reconcile.
      if (cleanupErrors.length > 0) {
        warn(`Cleanup after a failed ${op.kind} reported: ${cleanupErrors.join('; ')}`);
      }
      return;
    }
    // A signal can land after the body started mutating but before it
    // registered a journal, so the marker is written regardless.
    const suffix = cleanupErrors.length > 0 ? `; cleanup errors: ${cleanupErrors.join('; ')}` : '';
    await recordMarker(`${subject} before any state was captured${suffix}`);
    return;
  }

  let rollbackError: string | undefined;
  try {
    await withTimeout(
      restoreRollbackJournal(op.journal),
      SIGNAL_ROLLBACK_TIMEOUT_MS,
      'Rollback journal restore'
    );
  } catch (error: unknown) {
    rollbackError = toError(error).message;
  }

  // A clean rollback is not itself a repairable problem: the engine was
  // restored and the next `doctor` run stays green.
  if (!rollbackError && cleanupErrors.length === 0) {
    if (cause.kind === 'throw') verbose(`Rolled back ${op.kind} after a failure; engine restored.`);
    return;
  }

  const reasonParts: string[] = [subject];
  if (rollbackError) {
    reasonParts.push(`automatic rollback failed: ${rollbackError}`);
    if (cause.kind === 'throw') {
      warn(
        `Automatic rollback after a failed ${op.kind} did not complete: ${rollbackError}. ` +
          'Run "fireforge doctor --repair-furnace" to reconcile.'
      );
    }
  } else {
    reasonParts.push('automatic rollback succeeded');
  }
  if (cleanupErrors.length > 0) {
    reasonParts.push(`cleanup errors: ${cleanupErrors.join('; ')}`);
  }
  await recordMarker(reasonParts.join('; '));
}

/**
 * Operations whose partial effects a rerun does not repair: authoring and
 * removal edit `furnace.json`, `components/` and registrations together, so
 * they keep an in-flight sidecar for the duration. Apply, deploy and preview
 * are idempotent and self-heal when rerun.
 */
/** Sidecar filename for {@link adoptCrashedFurnaceMutation}. */
const FURNACE_INFLIGHT_FILENAME = 'furnace-inflight.json';

interface InflightRecord {
  operation: FurnacePendingRepairOperation;
  pid: number;
  startedAt: string;
}

const CRASH_MARKED_OPERATIONS: ReadonlySet<FurnacePendingRepairOperation> = new Set([
  'remove-rollback',
  'create-rollback',
  'override-rollback',
  'scan-rollback',
  'rename-rollback',
  'refresh-rollback',
  'chrome-doc-rollback',
]);

/** Sidecar recording the crash-marked operation that holds the furnace lock. */
function getInflightPath(root: string): string {
  return join(root, FIREFORGE_DIR, FURNACE_INFLIGHT_FILENAME);
}

/**
 * Records the operation in a sidecar before its first mutation. The sidecar
 * is not part of `furnace-state.json`, so readers that never take the lock
 * (`status`, `doctor`, a peer's build) cannot mistake a live mutation for a
 * failed one.
 */
async function writeInflightRecord(op: ActiveFurnaceOperation): Promise<void> {
  if (!CRASH_MARKED_OPERATIONS.has(op.kind)) return;
  const record: InflightRecord = {
    operation: op.kind,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await mkdir(join(op.root, FIREFORGE_DIR), { recursive: true });
  await writeFile(getInflightPath(op.root), JSON.stringify(record));
  op.inflightRecorded = true;
}

/** Removes this operation's sidecar once its outcome is known and recorded. */
async function clearInflightRecord(op: ActiveFurnaceOperation): Promise<void> {
  if (!op.inflightRecorded) return;
  op.inflightRecorded = false;
  try {
    await rm(getInflightPath(op.root), { force: true });
  } catch (error: unknown) {
    warn(`Could not remove the in-flight furnace record: ${toError(error).message}`);
  }
}

/**
 * Converts the sidecar a killed process left behind into a real
 * `pendingRepair` marker, so a torn authoring or removal operation is
 * visible to `doctor` and refused by the next mutation. A hard kill (SIGKILL,
 * OOM, power loss) cannot roll back, and these operations are not repaired by
 * a rerun.
 *
 * @param root - Project root
 * @param holdsLock - True when the caller holds the furnace lock, so no live
 *   process can own the sidecar; otherwise the lock must be free
 * @returns True when a marker was written
 */
export async function adoptCrashedFurnaceMutation(
  root: string,
  holdsLock: boolean
): Promise<boolean> {
  let record: InflightRecord;
  try {
    record = JSON.parse(await readFile(getInflightPath(root), 'utf8')) as InflightRecord;
  } catch {
    return false;
  }
  if (!holdsLock && (await readLockStatus(getFurnaceLockPath(root))).held) return false;
  await persistPendingRepair(
    root,
    record.operation,
    `the process (pid ${record.pid}) that started it at ${record.startedAt} ended before it finished or rolled back, ` +
      'so furnace.json, components/ and the engine may be partially modified'
  );
  await rm(getInflightPath(root), { force: true });
  return true;
}

async function persistPendingRepair(
  root: string,
  operation: FurnacePendingRepairOperation,
  reason: string
): Promise<void> {
  await updateFurnaceState(root, (state) => ({
    ...state,
    pendingRepair: {
      operation,
      timestamp: new Date().toISOString(),
      reason,
    },
  }));
}

/** Refuses a mutation while a previous operation's repair marker is set. */
async function assertNoPendingRepair(root: string): Promise<void> {
  const { pendingRepair } = await loadFurnaceState(root);
  if (pendingRepair) {
    throw new FurnaceError(
      `A previous "${pendingRepair.operation}" left the engine in an inconsistent state ` +
        `(${pendingRepair.reason}). Run "fireforge doctor --repair-furnace" to reconcile ` +
        'before running further furnace mutations.'
    );
  }
}

/**
 * Resolves the path of the lock directory used to serialize furnace mutations
 * for a given project root. Exposed for tests. Production callers should not
 * touch this directly.
 */
export function getFurnaceLockPath(root: string): string {
  return join(root, FIREFORGE_DIR, FURNACE_LOCK_FILENAME);
}

/**
 * Completes the rollback for a mutation body that owns its journal end to
 * end, then rethrows. Never returns normally.
 *
 * Shaped as a catch-body handler because the calling bodies differ in early
 * returns and in what they close over.
 *
 * The restore promise is registered before its work starts, so shutdown can
 * join it rather than skipping an in-flight journal. Completion is recorded
 * only when restoration settles. The original error is rethrown unless the
 * rollback itself failed; incomplete restoration records pending repair.
 *
 * @param ctx - The furnace operation context from `runFurnaceMutation`
 * @param journal - Rollback journal this body populated
 * @param error - The error the body threw
 * @param options - Project root, pending-repair tag, and message fragments
 * @returns Never, because it always throws
 */
export async function completeJournalRollback(
  ctx: FurnaceOperationContext,
  journal: RollbackJournal,
  error: unknown,
  options: {
    projectRoot: string;
    operation: FurnacePendingRepairOperation;
    /** Prefix for the restore failure, e.g. `Failed to override component "x"`. */
    failureMessage: string;
    /** Subject recorded on the pending-repair marker, e.g. `component "x"`. */
    subject: string;
  }
): Promise<never> {
  await runFurnaceRollback(ctx, async () => {
    try {
      await restoreRollbackJournalOrThrow(journal, options.failureMessage);
    } catch (rollbackError: unknown) {
      await recordFurnaceRollbackFailure(
        options.projectRoot,
        options.operation,
        `${options.subject}: ${toError(rollbackError).message}`
      );
      throw rollbackError;
    }
  });
  throw error;
}

/** Keep every body-owned restore visible to bounded shutdown until it actually settles. */
export async function runFurnaceRollback(
  ctx: FurnaceOperationContext | undefined,
  restore: () => Promise<void>
): Promise<void> {
  if (ctx?.runRollback) return ctx.runRollback(restore);
  try {
    await restore();
  } finally {
    ctx?.markRolledBack();
  }
}

/**
 * Forcibly removes the furnace lock directory for every active operation.
 *
 * The bin-layer signal handler calls `process.exit` after rollback, which
 * short-circuits Node's normal unwinding, so `withFileLock`'s `finally { rm
 * }` never runs and the lock directory survives the process. The next
 * FireForge command then has to either wait out the staleness window or
 * have the operator remove the lock manually. This sweeper runs inside
 * the signal-handler pipeline before `process.exit`, so the lock is gone
 * by the time the next command starts.
 *
 * Errors are logged and swallowed: we do not want a slow I/O failure at
 * shutdown to prevent the process from exiting. The doctor-side stale
 * lock check (`src/commands/doctor-furnace.ts`) is the backup path for
 * any lock that escapes this sweep.
 */
export async function forceReleaseFurnaceLocksForActiveOperations(): Promise<void> {
  const paths = new Set([...activeOperations.values()].map((op) => getFurnaceLockPath(op.root)));
  for (const lockPath of paths) {
    // Ownership-checked, like every other release path. A bare `rm` would
    // delete a lock a different process had acquired in the window between
    // our operation dying and this sweep running. That is the exact race
    // `releaseLock`'s PID verification closes, and the sweeper has no
    // acquisition token to check.
    const removed = await releaseLockIfOwned(lockPath);
    verbose(
      removed
        ? `Removed furnace lock at ${lockPath} during signal teardown`
        : `Left furnace lock at ${lockPath} in place during signal teardown: it is not owned by this process`
    );
  }
}

/**
 * Runs a furnace-mutating body under the apply-wide lock and registers it
 * with the process-wide SIGINT/SIGTERM rollback pathway. The lock prevents
 * two `furnace apply`/`deploy`/`create`/etc. runs from racing on the engine
 * working copy. The CLI entrypoint's global signal handlers consult this
 * registry and invoke rollback (writing a `pendingRepair` marker when needed)
 * if the user hits Ctrl+C mid-run.
 *
 * Dry-run callers should pass `options.dryRun = true` so the wrapper skips
 * the lock entirely (concurrent dry-runs are safe and shouldn't block each
 * other).
 *
 * The body receives a {@link FurnaceOperationContext}. It must call
 * `ctx.registerJournal(journal)` once it has constructed its rollback journal.
 * Bodies that don't manage a journal directly (e.g. apply, which delegates to
 * `applyAllComponents`) can pass an internal callback through.
 */
export async function runFurnaceMutation<T>(
  root: string,
  kind: FurnacePendingRepairOperation,
  body: (ctx: FurnaceOperationContext) => Promise<T>,
  options: RunFurnaceMutationOptions = {}
): Promise<T> {
  if (options.dryRun) {
    // Dry-run: no lock, no signal handler, no journal registration. The body
    // is still given a no-op context so callers can use the same shape.
    return body({
      registerJournal: () => undefined,
      commitJournal: () => undefined,
      registerCleanup: () => undefined,
      markRolledBack: () => undefined,
    });
  }

  // Pre-flight: refuse to mutate when a previous operation left the engine in
  // a partially-rolled-back state. The user must run `fireforge doctor
  // --repair-furnace` to reconcile before any new mutations can proceed.
  // Checked again under the lock, where it is authoritative.
  if (!options.skipPendingRepairCheck) {
    await assertNoPendingRepair(root);
  }

  const token = nextOperationToken++;
  const operation: ActiveFurnaceOperation = { root, kind, cleanups: [] };

  const lockPath = getFurnaceLockPath(root);
  // An explicit budget wins. Otherwise the session-wide one applies. Naming
  // the lock in the refusal matters: a mutation takes two, and a message
  // that says only "timed out" sends the operator to raise a budget that
  // was already large enough for the other lock.
  const timeoutMs = options.lockTimeoutMs ?? sessionWaitLockMs();
  const lockOptions = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    onTimeoutMessage:
      `Timed out waiting for the FURNACE lock at ${lockPath} ` +
      `(this is the second of the two locks a furnace mutation takes; the first is the engine session lock). ` +
      'Another fireforge furnace command may be running. ' +
      'Raise the budget with --wait-lock <seconds> or FIREFORGE_WAIT_LOCK, which governs both. ' +
      'If no other process is running, remove the stale lock directory and retry.',
    onStaleLockMessage: (ageMs: number) =>
      `Removing stale furnace lock (age: ${Math.round(ageMs / 1000)}s). ` +
      'A previous fireforge process may have crashed.',
  };

  return withFileLock(
    lockPath,
    async () => {
      // Everything the body does from here is serialized only by the furnace
      // lock, so confirm we are actually inside it before registering as a
      // live mutation. The owner record is best-effort in `withFileLock`
      // (a live holder can legitimately have no readable PID), so the PID
      // half only tightens the check when a record is present. Asserting on
      // its existence would fire on a lock we really do hold.
      const lockStatus = await readLockStatus(lockPath);
      assert(lockStatus.held, 'furnace lock held before the mutation body runs');
      assert(
        lockStatus.holder === undefined || lockStatus.holder.pid === process.pid,
        () =>
          `furnace lock is owned by this process ` +
          `(held by PID ${lockStatus.holder?.pid}, we are ${process.pid})`
      );

      await adoptCrashedFurnaceMutation(root, true);
      if (!options.skipPendingRepairCheck) {
        await assertNoPendingRepair(root);
      }

      activeOperations.set(token, operation);
      try {
        await writeInflightRecord(operation);
        const outcome = await trackRollbackMutations(
          () => operation.journal,
          () =>
            body({
              registerJournal: (journal) => {
                operation.journal = journal;
                rearmRollback(operation);
              },
              commitJournal: () => {
                delete operation.journal;
                rearmRollback(operation);
              },
              registerCleanup: (cleanup) => {
                operation.cleanups.push(cleanup);
              },
              markRolledBack: () => {
                operation.rollbackState = 'done';
              },
              runRollback: (restore) => rollbackOnce(operation, restore),
            })
        );
        await clearInflightRecord(operation);
        return outcome;
      } catch (error: unknown) {
        // A thrown error leaves the engine mutated exactly as a signal does,
        // so it gets the same treatment. A bare finally here would
        // deregister the operation and mark it completed, removing it from
        // the signal handler's view too, so a body that threw outside its
        // own catch (notably anywhere in `applyAllComponents` outside its
        // two per-component try blocks) would leave the checkout torn with
        // no marker.
        //
        // This runs inside the withFileLock callback, so the furnace lock is
        // still held for the duration of the restore: a competing process
        // cannot start mutating half-way through it.
        await rollbackOperation(operation, { kind: 'throw' });
        throw error;
      } finally {
        if (operation.rollbackPromise) await operation.rollbackPromise.catch(() => undefined);
        operation.completed = true;
        activeOperations.delete(token);
      }
    },
    lockOptions
  );
}

/**
 * Persists an `apply-rollback` (or other operation-kind) `pendingRepair`
 * marker on behalf of a caller that detected a rollback failure outside the
 * signal-handler path (e.g. apply's own catch-around-restore). Exposed so
 * `furnace-apply.ts` can write the marker without taking on a dependency on
 * the lifecycle wrapper's internals.
 */
export async function recordFurnaceRollbackFailure(
  root: string,
  operation: FurnacePendingRepairOperation,
  reason: string
): Promise<void> {
  await persistPendingRepair(root, operation, reason);
}

/**
 * Test-only helper: tears down the module-scoped state. Vitest workers may
 * reuse the module across tests, so the test suite must call this between
 * cases that exercise the signal pathway. Not exported from the package
 * entry point.
 *
 * @internal Exported only so tests can reach it. Not part of the public
 * surface.
 */
export function __resetFurnaceOperationStateForTests(): void {
  activeOperations.clear();
  nextOperationToken = 1;
  signalRollbackInFlight = false;
}
