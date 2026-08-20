// SPDX-License-Identifier: EUPL-1.2
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type { FurnacePendingRepairOperation } from '../types/furnace.js';
import { assert } from '../utils/assert.js';
import { toError } from '../utils/errors.js';
import { verbose, warn } from '../utils/logger.js';
import { FIREFORGE_DIR } from './config-paths.js';
import { readLockStatus, withFileLock } from './file-lock.js';
import { loadFurnaceState, updateFurnaceState } from './furnace-config.js';
import { restoreRollbackJournal, type RollbackJournal } from './furnace-rollback.js';

/** Sidecar lock filename used to serialize concurrent furnace mutations. */
const FURNACE_LOCK_FILENAME = 'furnace.lock';

/**
 * The signal names the lifecycle wrapper knows how to react to. Spelled out
 * as a literal union (rather than `NodeJS.Signals`) so the public type
 * surface does not depend on the NodeJS global namespace — consumers of
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
   * Registers the rollback journal for the current operation. Must be called
   * once the body has constructed its journal so the signal handler can find
   * it. Calling more than once replaces the prior reference (this is fine for
   * commands that build the journal lazily).
   */
  registerJournal(journal: RollbackJournal): void;
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
   * Bodies that catch-and-restore on their own (the `furnace/*` command
   * bodies, `furnace-apply`) call this from their catch block after the
   * restore, then re-throw. Without it the wrapper would restore the same
   * journal again on the way out — harmless for the file writes, which are
   * rename-based and converge, but it would race a second `pendingRepair`
   * write against the state-file lock.
   */
  markRolledBack(): void;
}

/** Options for `runFurnaceMutation`. */
export interface RunFurnaceMutationOptions {
  /**
   * If true, skip lock acquisition and signal-handler installation entirely.
   * Used by dry-run paths where no engine mutation occurs.
   *
   * Note: a dry-run can overlap with a real mutation because it does not
   * acquire the lock. This is safe because dry-runs only read; however, a
   * dry-run that starts before a real mutation and finishes after it may
   * observe partially-written engine state. Accept this trade-off so that
   * concurrent dry-runs never block each other or a real apply.
   */
  dryRun?: boolean;
  /**
   * Override the default 30s lock timeout. The watch-mode caller may want a
   * shorter window so an interactive rebuild fails fast instead of stalling.
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
 * Module-scoped registry of in-flight furnace operations. Indexed by an
 * incrementing token so multiple nested mutations (e.g. preview wrapping
 * apply) each get their own slot — though in practice the apply-wide lock
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
   * Which path, if any, has claimed this operation's rollback.
   *
   * Both the throw path (`runFurnaceMutation`'s catch) and the signal path
   * (`rollbackActiveOperationsForSignal`) can reach the same journal: a
   * SIGINT landing mid-throw-path-restore finds the operation still in
   * `activeOperations` with `completed !== true`, because `completed` is
   * only set in the finally that runs after the catch. This field is the
   * interlock — whichever path gets there first claims it synchronously,
   * before its first await, and the other skips. It is per-operation
   * rather than module-scoped because the registry is keyed to allow
   * concurrent operations.
   */
  rollbackState?: 'in-flight' | 'done';
}

/**
 * Claims the rollback for one operation, or reports that another path
 * already has it.
 *
 * Must stay synchronous and must be called before the caller's first
 * await — that is what makes the claim atomic against the signal handler.
 *
 * @param operation - The in-flight operation to claim
 * @returns True when the caller now owns the rollback
 */
function claimRollback(operation: ActiveFurnaceOperation): boolean {
  if (operation.rollbackState !== undefined) {
    return false;
  }
  operation.rollbackState = 'in-flight';
  return true;
}

const activeOperations = new Map<number, ActiveFurnaceOperation>();
let nextOperationToken = 1;
let signalRollbackInFlight = false;

/**
 * Returns true while a signal-driven rollback is in progress. The bin entry
 * point uses this as a re-entrancy guard so a user mashing Ctrl+C cannot
 * trigger a second rollback that races the first. Exposed for the bin shim
 * (and the test suite); production callers should not need it.
 */
export function isSignalRollbackInFlight(): boolean {
  return signalRollbackInFlight;
}

/**
 * Rolls back every in-flight furnace operation and writes a pendingRepair
 * marker for each. The bin entry point installs SIGINT/SIGTERM handlers that
 * call this and then exit; calling it directly from inside the library would
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
  // work — this would mis-trigger the rollback banner for plain `fireforge
  // run` (which never registers a mutation but can receive SIGTERM).
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
    // The body may already be rolling back on its own throw path. Claim the
    // operation (or skip it) before the first await so the two paths cannot
    // both restore the same journal.
    if (!claimRollback(op)) {
      verbose(`Rollback for ${op.kind} already in progress; leaving it to the throw path.`);
      continue;
    }

    const cleanupErrors: string[] = [];

    // Run extra cleanup callbacks first (e.g. preview's cleanStories), so the
    // engine is in its tidiest possible shape before the journal restore
    // writes the original file contents back over the top.
    for (const cleanup of op.cleanups) {
      try {
        await withTimeout(cleanup(), SIGNAL_ROLLBACK_TIMEOUT_MS, 'Cleanup callback');
      } catch (error: unknown) {
        cleanupErrors.push(toError(error).message);
      }
    }

    if (!op.journal) {
      // The body had not yet handed us a journal — nothing to roll back. We
      // still write a marker because the body may have started mutating the
      // engine before reaching the registerJournal call.
      const cleanupSuffix =
        cleanupErrors.length > 0 ? `; cleanup errors: ${cleanupErrors.join('; ')}` : '';
      await persistPendingRepair(
        op.root,
        op.kind,
        `interrupted by ${signal} before any state was captured${cleanupSuffix}`
      ).catch((error: unknown) => {
        warn(`Could not persist pending-repair marker: ${toError(error).message}`);
      });
      continue;
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
    op.rollbackState = 'done';

    // A clean signal-driven rollback is not itself a repairable problem:
    // preview/apply/deploy/remove were interrupted, but the engine was restored
    // successfully and the next `doctor` run should remain green. Persist a
    // pending-repair marker only when rollback was incomplete or uncertain.
    if (rollbackError || cleanupErrors.length > 0) {
      const reasonParts: string[] = [`interrupted by ${signal}`];
      if (rollbackError) {
        reasonParts.push(`automatic rollback failed: ${rollbackError}`);
      } else {
        reasonParts.push('automatic rollback succeeded');
      }
      if (cleanupErrors.length > 0) {
        reasonParts.push(`cleanup errors: ${cleanupErrors.join('; ')}`);
      }
      await persistPendingRepair(op.root, op.kind, reasonParts.join('; ')).catch(
        (error: unknown) => {
          warn(`Could not persist pending-repair marker: ${toError(error).message}`);
        }
      );
    }
  }
}

/**
 * Rolls back one operation whose body threw, mirroring the signal path.
 *
 * Never throws: the body's own error is what the operator needs to see, so
 * a rollback failure becomes a `pendingRepair` marker plus a warning
 * rather than replacing it. Skips entirely when the body already restored
 * its own journal and said so via `ctx.markRolledBack()`.
 *
 * @param operation - The in-flight operation whose body threw
 */
async function rollbackOperationForThrow(operation: ActiveFurnaceOperation): Promise<void> {
  if (!claimRollback(operation)) {
    return;
  }

  const cleanupErrors: string[] = [];

  // Cleanups before the journal restore, for the same reason the signal path
  // does it in that order: the restore writes original contents back, and it
  // should do so over the tidiest possible tree.
  for (const cleanup of operation.cleanups) {
    try {
      await withTimeout(cleanup(), SIGNAL_ROLLBACK_TIMEOUT_MS, 'Cleanup callback');
    } catch (error: unknown) {
      cleanupErrors.push(toError(error).message);
    }
  }

  if (!operation.journal) {
    // Nothing was captured, so there is nothing to restore. Unlike the signal
    // path we do NOT write a pendingRepair marker here: a body that threw
    // before registering a journal is overwhelmingly a refusal raised during
    // pre-flight (a validation failure, a missing file), and marking the root
    // as needing repair would block every later furnace mutation behind a
    // `doctor --repair-furnace` that has nothing to reconcile. Bodies that
    // genuinely mutate before registering a journal are the ones the
    // journal-before-mutation assertions catch.
    operation.rollbackState = 'done';
    if (cleanupErrors.length > 0) {
      warn(`Cleanup after a failed ${operation.kind} reported: ${cleanupErrors.join('; ')}`);
    }
    return;
  }

  let rollbackError: string | undefined;
  try {
    await withTimeout(
      restoreRollbackJournal(operation.journal),
      SIGNAL_ROLLBACK_TIMEOUT_MS,
      'Rollback journal restore'
    );
  } catch (error: unknown) {
    rollbackError = toError(error).message;
  }
  operation.rollbackState = 'done';

  if (!rollbackError && cleanupErrors.length === 0) {
    verbose(`Rolled back ${operation.kind} after a failure; engine restored.`);
    return;
  }

  const reasonParts: string[] = [`${operation.kind} failed`];
  if (rollbackError) {
    reasonParts.push(`automatic rollback failed: ${rollbackError}`);
    warn(
      `Automatic rollback after a failed ${operation.kind} did not complete: ${rollbackError}. ` +
        'Run "fireforge doctor --repair-furnace" to reconcile.'
    );
  } else {
    reasonParts.push('automatic rollback succeeded');
  }
  if (cleanupErrors.length > 0) {
    reasonParts.push(`cleanup errors: ${cleanupErrors.join('; ')}`);
  }

  await persistPendingRepair(operation.root, operation.kind, reasonParts.join('; ')).catch(
    (error: unknown) => {
      warn(`Could not persist pending-repair marker: ${toError(error).message}`);
    }
  );
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

/**
 * Resolves the path of the lock directory used to serialize furnace mutations
 * for a given project root. Exposed for tests; production callers should not
 * touch this directly.
 */
export function getFurnaceLockPath(root: string): string {
  return join(root, FIREFORGE_DIR, FURNACE_LOCK_FILENAME);
}

/**
 * Forcibly removes the furnace lock directory for every active operation.
 *
 * The bin-layer signal handler calls `process.exit` after rollback, which
 * short-circuits Node's normal unwinding — `withFileLock`'s `finally { rm
 * }` never runs, so the lock directory survives the process. The next
 * FireForge command then has to either wait out the staleness window or
 * have the operator remove the lock manually. This sweeper runs inside
 * the signal-handler pipeline BEFORE `process.exit`, so the lock is gone
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
    try {
      await rm(lockPath, { recursive: true, force: true });
      verbose(`Removed furnace lock at ${lockPath} during signal teardown`);
    } catch (error: unknown) {
      verbose(
        `Could not remove furnace lock at ${lockPath} during signal teardown: ${toError(error).message}`
      );
    }
  }
}

/**
 * Runs a furnace-mutating body under the apply-wide lock and registers it
 * with the process-wide SIGINT/SIGTERM rollback pathway. The lock prevents
 * two `furnace apply`/`deploy`/`create`/etc. runs from racing on the engine
 * working copy; the CLI entrypoint's global signal handlers consult this
 * registry and invoke rollback (writing a `pendingRepair` marker when needed)
 * if the user hits Ctrl+C mid-run.
 *
 * Dry-run callers should pass `options.dryRun = true` so the wrapper skips
 * the lock entirely (concurrent dry-runs are safe and shouldn't block each
 * other).
 *
 * The body receives a {@link FurnaceOperationContext}; it must call
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
      registerCleanup: () => undefined,
      markRolledBack: () => undefined,
    });
  }

  // Pre-flight: refuse to mutate when a previous operation left the engine in
  // a partially-rolled-back state. The user must run `fireforge doctor
  // --repair-furnace` to reconcile before any new mutations can proceed.
  if (!options.skipPendingRepairCheck) {
    const state = await loadFurnaceState(root);
    if (state.pendingRepair) {
      throw new FurnaceError(
        `A previous "${state.pendingRepair.operation}" left the engine in an inconsistent state ` +
          `(${state.pendingRepair.reason}). Run "fireforge doctor --repair-furnace" to reconcile ` +
          'before running further furnace mutations.'
      );
    }
  }

  const token = nextOperationToken++;
  const operation: ActiveFurnaceOperation = { root, kind, cleanups: [] };

  const lockPath = getFurnaceLockPath(root);
  const lockOptions = {
    ...(options.lockTimeoutMs !== undefined ? { timeoutMs: options.lockTimeoutMs } : {}),
    onTimeoutMessage:
      `Timed out waiting for the furnace lock at ${lockPath}. ` +
      'Another fireforge furnace command may be running. ' +
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
      // live mutation. The owner record is deliberately best-effort in
      // `withFileLock` (a live holder can legitimately have no readable PID),
      // so the PID half only tightens the check when a record is present —
      // asserting on its existence would fire on a lock we really do hold.
      const lockStatus = await readLockStatus(lockPath);
      assert(lockStatus.held, 'furnace lock held before the mutation body runs');
      assert(
        lockStatus.holder === undefined || lockStatus.holder.pid === process.pid,
        () =>
          `furnace lock is owned by this process ` +
          `(held by PID ${String(lockStatus.holder?.pid)}, we are ${String(process.pid)})`
      );

      activeOperations.set(token, operation);
      try {
        return await body({
          registerJournal: (journal) => {
            operation.journal = journal;
          },
          registerCleanup: (cleanup) => {
            operation.cleanups.push(cleanup);
          },
          markRolledBack: () => {
            operation.rollbackState = 'done';
          },
        });
      } catch (error: unknown) {
        // A thrown error leaves the engine mutated exactly as a signal does,
        // so it gets the same treatment. Before 0.43.0 this was a bare
        // finally: the throw path deregistered the operation and marked it
        // completed, which removed it from the signal handler's view too, so
        // a body that threw outside its own catch (notably anywhere in
        // `applyAllComponents` outside its two per-component try blocks) left
        // the checkout torn with no marker.
        //
        // This runs inside the withFileLock callback, so the furnace lock is
        // still held for the duration of the restore — a competing process
        // cannot start mutating half-way through it.
        await rollbackOperationForThrow(operation);
        throw error;
      } finally {
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
 */
export function __resetFurnaceOperationStateForTests(): void {
  activeOperations.clear();
  nextOperationToken = 1;
  signalRollbackInFlight = false;
}
