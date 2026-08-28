// SPDX-License-Identifier: EUPL-1.2
/* eslint-disable @typescript-eslint/require-await --
 * Many of the test bodies for runFurnaceMutation are intentionally trivial
 * arrow functions whose only job is to return a value or throw — there is
 * nothing to await inside them, but the wrapper signature requires a
 * Promise-returning function. Disabling require-await file-wide is cleaner
 * than wrapping every literal in `Promise.resolve(...)`.
 */
/* eslint-disable @typescript-eslint/no-non-null-assertion --
 * The test inspects the recorded mock calls and uses non-null assertions to
 * narrow them; the assertions are guarded by an explicit toHaveBeenCalled
 * check above each one.
 */
/* eslint-disable @typescript-eslint/no-unsafe-assignment --
 * Mock-call introspection (`updateFurnaceStateMock.mock.calls`) is inherently
 * any-typed at the boundary; the test casts the captured updater fn back to
 * a known shape locally.
 */
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../furnace-config.js', () => ({
  loadFurnaceState: vi.fn((): Promise<Record<string, unknown>> => Promise.resolve({})),
  updateFurnaceState: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
}));

import { writeFile } from 'node:fs/promises';

import { nativePath } from '../../test-utils/index.js';
import { loadFurnaceState, updateFurnaceState } from '../furnace-config.js';
import {
  __resetFurnaceOperationStateForTests,
  forceReleaseFurnaceLocksForActiveOperations,
  getFurnaceLockPath,
  recordFurnaceRollbackFailure,
  rollbackActiveOperationsForSignal,
  runFurnaceMutation,
  waitLockMutationOptions,
} from '../furnace-operation.js';
import { createRollbackJournal, snapshotFile } from '../furnace-rollback.js';

const loadFurnaceStateMock = vi.mocked(loadFurnaceState);
const updateFurnaceStateMock = vi.mocked(updateFurnaceState);

const cleanupPaths: string[] = [];

async function makeTempProject(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  await mkdir(join(dir, '.fireforge'), { recursive: true });
  return dir;
}

async function pathExistsOnDisk(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  loadFurnaceStateMock.mockClear();
  loadFurnaceStateMock.mockResolvedValue({});
  updateFurnaceStateMock.mockClear();
  updateFurnaceStateMock.mockResolvedValue(undefined);
});

afterEach(async () => {
  __resetFurnaceOperationStateForTests();
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

describe('runFurnaceMutation', () => {
  it('resolves the furnace lock path under the .fireforge directory', () => {
    expect(getFurnaceLockPath('/project')).toBe(nativePath('/project/.fireforge/furnace.lock'));
  });

  it('returns the body result on the happy path', async () => {
    const root = await makeTempProject('fireforge-furnace-op-');

    const result = await runFurnaceMutation(root, 'apply-rollback', async () => 'ok');

    expect(result).toBe('ok');
  });

  it('skips the lock entirely on dry-run', async () => {
    const root = await makeTempProject('fireforge-furnace-op-dry-');

    const result = await runFurnaceMutation(root, 'apply-rollback', async () => 'dry', {
      dryRun: true,
    });

    expect(result).toBe('dry');
    // Two concurrent dry-runs against the same root must not block each other.
    const [a, b] = await Promise.all([
      runFurnaceMutation(root, 'apply-rollback', async () => 'a', { dryRun: true }),
      runFurnaceMutation(root, 'apply-rollback', async () => 'b', { dryRun: true }),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('serializes two concurrent furnace mutations against the same root', async () => {
    const root = await makeTempProject('fireforge-furnace-op-serial-');
    const events: string[] = [];

    const first = runFurnaceMutation(root, 'apply-rollback', async () => {
      events.push('a-start');
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push('a-end');
      return 'a';
    });

    // Give the first mutation a beat to acquire the lock before the second
    // starts polling.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = runFurnaceMutation(root, 'apply-rollback', async () => {
      events.push('b-start');
      events.push('b-end');
      return 'b';
    });

    const results = await Promise.all([first, second]);
    expect(results).toEqual(['a', 'b']);
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('times out with a furnace-specific message when the lock is held', async () => {
    const root = await makeTempProject('fireforge-furnace-op-timeout-');
    // Pre-create the lock directory to simulate another process holding it.
    await mkdir(getFurnaceLockPath(root));

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async () => 'unreachable', {
        lockTimeoutMs: 25,
      })
    ).rejects.toThrow(/FURNACE lock/);
  });

  it('removes the signal listeners after a successful run', async () => {
    const root = await makeTempProject('fireforge-furnace-op-cleanup-');
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    await runFurnaceMutation(root, 'apply-rollback', async () => undefined);

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });

  it('passes through errors thrown by the body and still releases the lock', async () => {
    const root = await makeTempProject('fireforge-furnace-op-error-');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    // Lock must be released so a follow-up mutation can run immediately.
    const result = await runFurnaceMutation(root, 'apply-rollback', async () => 'after');
    expect(result).toBe('after');
  });

  it('refuses mutation when pendingRepair marker exists', async () => {
    const root = await makeTempProject('fireforge-furnace-op-repair-');
    loadFurnaceStateMock.mockResolvedValue({
      pendingRepair: {
        operation: 'preview-teardown',
        timestamp: '2026-01-01T00:00:00.000Z',
        reason: 'teardown failed',
      },
    });

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async () => 'unreachable')
    ).rejects.toThrow(/fireforge doctor --repair-furnace/);
  });

  it('allows mutation when skipPendingRepairCheck is set', async () => {
    const root = await makeTempProject('fireforge-furnace-op-repair-skip-');
    loadFurnaceStateMock.mockResolvedValue({
      pendingRepair: {
        operation: 'preview-teardown',
        timestamp: '2026-01-01T00:00:00.000Z',
        reason: 'teardown failed',
      },
    });

    const result = await runFurnaceMutation(root, 'apply-rollback', async () => 'ok', {
      skipPendingRepairCheck: true,
    });
    expect(result).toBe('ok');
  });

  it('exposes the registered journal slot to the body via the context', async () => {
    const root = await makeTempProject('fireforge-furnace-op-journal-');

    const result = await runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      // Touching the journal verifies it is the same shape rollback expects.
      const file = join(root, 'sentinel.txt');
      await snapshotFile(journal, file);
      return journal.files.size;
    });

    expect(result).toBe(1);
  });
});

describe('runFurnaceMutation rollback on a thrown error', () => {
  it('restores the registered journal and rethrows the original error', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    const bodyError = new Error('apply blew up after mutating');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        await writeFile(sentinel, 'corrupted');
        throw bodyError;
      })
    ).rejects.toBe(bodyError);

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(sentinel, 'utf8')).toBe('pristine');

    // A clean rollback is not a repairable failure.
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
    // And the lock is gone, so the next command is not blocked.
    expect(await pathExistsOnDisk(getFurnaceLockPath(root))).toBe(false);
  });

  it('runs cleanup callbacks before the journal restore', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-order-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    const order: string[] = [];

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        ctx.registerCleanup(async () => {
          const { readFile } = await import('node:fs/promises');
          // The journal restore has not run yet, so the mutation is still visible.
          order.push(`cleanup:${await readFile(sentinel, 'utf8')}`);
        });
        await writeFile(sentinel, 'corrupted');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(order).toEqual(['cleanup:corrupted']);
  });

  it('writes a pending-repair marker when the throw-path restore fails', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-badrestore-');
    const nested = join(root, 'sub');
    await mkdir(nested, { recursive: true });
    const sentinel = join(nested, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        // Replace the parent directory with a regular file so the restore's
        // mkdir(dirname) fails with ENOTDIR.
        await rm(nested, { recursive: true, force: true });
        await writeFile(nested, 'now a file');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(updateFurnaceStateMock).toHaveBeenCalled();
  });

  it('does not restore again when the body already rolled back and said so', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-marked-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        await writeFile(sentinel, 'body-restored-this-itself');
        // The body claims the rollback without actually restoring, so the
        // file content is the observable proof the wrapper kept its hands off.
        ctx.markRolledBack();
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(sentinel, 'utf8')).toBe('body-restored-this-itself');
  });

  it('writes no marker when the body threw before registering a journal', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-nojournal-');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async () => {
        throw new Error('refused during pre-flight');
      })
    ).rejects.toThrow('refused during pre-flight');

    // Unlike the signal path, a pre-flight refusal must not leave a
    // pendingRepair marker behind — it would block every later mutation
    // behind a repair that has nothing to reconcile.
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
  });

  it('does not double-restore when a signal lands during the throw-path rollback', async () => {
    const root = await makeTempProject('fireforge-furnace-op-throw-signal-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    await expect(
      runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        ctx.registerCleanup(async () => {
          // Cleanups run inside the throw path's rollback, which has already
          // claimed the operation — so this signal must find nothing to do.
          await rollbackActiveOperationsForSignal('SIGINT');
        });
        await writeFile(sentinel, 'corrupted');
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const { readFile } = await import('node:fs/promises');
    expect(await readFile(sentinel, 'utf8')).toBe('pristine');
    // The signal path must not have written its "before any state was
    // captured" marker for an operation the throw path owns.
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
  });
});

describe('rollbackActiveOperationsForSignal', () => {
  it('restores the registered journal without leaving a pending-repair marker when rollback succeeds cleanly', async () => {
    const root = await makeTempProject('fireforge-furnace-op-signal-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    let signalBodyReady: (() => void) | undefined;
    const bodyReady = new Promise<void>((resolve) => {
      signalBodyReady = resolve;
    });

    const runPromise = runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      await snapshotFile(journal, sentinel);
      // Simulate the apply having mutated the file before the signal arrives.
      await writeFile(sentinel, 'corrupted');
      // Signal the test deterministically — racing a setTimeout against
      // libuv's threadpool can leave writeFile('corrupted') in flight while
      // the rollback runs, producing an interleaved "pristined" result.
      signalBodyReady!();
      await bodyHeld;
      return 'done';
    });

    await bodyReady;

    await rollbackActiveOperationsForSignal('SIGINT');

    // The sentinel should be back to its pristine content.
    const { readFile } = await import('node:fs/promises');
    const restored = await readFile(sentinel, 'utf8');
    expect(restored).toBe('pristine');

    // A clean rollback is not a repairable failure and should not dirty the state file.
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();

    // Let the body finish so we can clean up the lock.
    releaseBody!();
    await runPromise;
  });

  it('writes a pending-repair marker when signal cleanup callbacks fail', async () => {
    const root = await makeTempProject('fireforge-furnace-op-signal-cleanup-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    let signalBodyReady: (() => void) | undefined;
    const bodyReady = new Promise<void>((resolve) => {
      signalBodyReady = resolve;
    });

    const runPromise = runFurnaceMutation(root, 'preview-teardown', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      ctx.registerCleanup(async () => {
        throw new Error('storybook cleanup failed');
      });
      await snapshotFile(journal, sentinel);
      await writeFile(sentinel, 'corrupted');
      signalBodyReady!();
      await bodyHeld;
      return 'done';
    });

    await bodyReady;
    await rollbackActiveOperationsForSignal('SIGINT');

    const { readFile } = await import('node:fs/promises');
    const restored = await readFile(sentinel, 'utf8');
    expect(restored).toBe('pristine');

    expect(updateFurnaceStateMock).toHaveBeenCalled();
    const lastCall = updateFurnaceStateMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const updater = lastCall![1] as (state: Record<string, unknown>) => Record<string, unknown>;
    const next = updater({});
    expect(next['pendingRepair']).toMatchObject({
      operation: 'preview-teardown',
      reason: expect.stringContaining('cleanup errors: storybook cleanup failed'),
    });

    releaseBody!();
    await runPromise;
  });

  it('force-releases the furnace lock after signal rollback while preview is still unwinding', async () => {
    const root = await makeTempProject('fireforge-furnace-op-signal-lock-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    let signalBodyReady: (() => void) | undefined;
    const bodyReady = new Promise<void>((resolve) => {
      signalBodyReady = resolve;
    });

    const runPromise = runFurnaceMutation(root, 'preview-teardown', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      await snapshotFile(journal, sentinel);
      await writeFile(sentinel, 'corrupted');
      signalBodyReady!();
      await bodyHeld;
      return 'done';
    });

    await bodyReady;
    expect(await pathExistsOnDisk(getFurnaceLockPath(root))).toBe(true);

    await rollbackActiveOperationsForSignal('SIGINT');
    await forceReleaseFurnaceLocksForActiveOperations();

    expect(await pathExistsOnDisk(getFurnaceLockPath(root))).toBe(false);

    releaseBody!();
    await runPromise;
  });

  it('writes a pending-repair marker when signal cleanup times out', async () => {
    const root = await makeTempProject('fireforge-furnace-op-signal-timeout-');
    const sentinel = join(root, 'engine-file.txt');
    await writeFile(sentinel, 'pristine');

    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    let signalBodyReady: (() => void) | undefined;
    const bodyReady = new Promise<void>((resolve) => {
      signalBodyReady = resolve;
    });

    const runPromise = runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      ctx.registerCleanup(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30_000));
      });
      await snapshotFile(journal, sentinel);
      await writeFile(sentinel, 'corrupted');
      signalBodyReady!();
      await bodyHeld;
      return 'done';
    });

    await bodyReady;
    await rollbackActiveOperationsForSignal('SIGINT');

    expect(updateFurnaceStateMock).toHaveBeenCalled();
    const lastCall = updateFurnaceStateMock.mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const updater = lastCall![1] as (state: Record<string, unknown>) => Record<string, unknown>;
    const next = updater({});
    expect(next['pendingRepair']).toMatchObject({
      operation: 'apply-rollback',
      reason: expect.stringContaining('timed out'),
    });

    releaseBody!();
    await runPromise;
  }, 30_000);

  it('writes a marker even when the body had not yet registered a journal', async () => {
    const root = await makeTempProject('fireforge-furnace-op-early-signal-');

    let releaseBody: (() => void) | undefined;
    const bodyHeld = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });

    let signalBodyReady: (() => void) | undefined;
    const bodyReady = new Promise<void>((resolve) => {
      signalBodyReady = resolve;
    });

    const runPromise = runFurnaceMutation(root, 'remove-rollback', async () => {
      // Note: deliberately do not call ctx.registerJournal — simulates a body
      // that took the signal before constructing its journal.
      signalBodyReady!();
      await bodyHeld;
      return 'done';
    });

    await bodyReady;
    await rollbackActiveOperationsForSignal('SIGTERM');

    expect(updateFurnaceStateMock).toHaveBeenCalled();
    const lastCall = updateFurnaceStateMock.mock.calls.at(-1)!;
    const updater = lastCall[1] as (state: Record<string, unknown>) => Record<string, unknown>;
    const next = updater({});
    expect(next['pendingRepair']).toMatchObject({
      operation: 'remove-rollback',
      reason: expect.stringContaining('before any state was captured'),
    });

    releaseBody!();
    await runPromise;
  });

  it('stays silent and writes no marker when there are no active operations', async () => {
    // Regression guard for the "fireforge run rollback false-positive" issue:
    // plain launch commands never register a mutation, so a SIGTERM landing
    // during run must not print the "rolling back in-flight furnace
    // mutations" banner nor write a pending-repair marker.
    const { warn } = await import('../../utils/logger.js');
    const warnMock = vi.mocked(warn);
    warnMock.mockClear();

    await rollbackActiveOperationsForSignal('SIGTERM');

    expect(warnMock).not.toHaveBeenCalled();
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
  });
});

describe('recordFurnaceRollbackFailure', () => {
  it('writes a pending-repair marker via updateFurnaceState', async () => {
    await recordFurnaceRollbackFailure('/some/root', 'apply-rollback', 'rollback failed: EACCES');

    expect(updateFurnaceStateMock).toHaveBeenCalledTimes(1);
    const [root, updater] = updateFurnaceStateMock.mock.calls[0]!;
    expect(root).toBe('/some/root');
    // The updater is a function that mutates the state in-place; invoke it
    // with an empty state to verify the marker shape.
    const next = (updater as (state: Record<string, unknown>) => Record<string, unknown>)({});
    expect(next).toMatchObject({
      pendingRepair: {
        operation: 'apply-rollback',
        reason: 'rollback failed: EACCES',
      },
    });
    expect((next['pendingRepair'] as { timestamp: string }).timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T/
    );
  });
});

describe('waitLockMutationOptions', () => {
  it('converts a wait budget in seconds to the furnace lock timeout in ms', () => {
    // The half of `--wait-lock` that used to be missing: the flag reached
    // the engine session lock and stopped there, so a contended mutation
    // met `.fireforge/furnace.lock` with a fixed 30 s after paying the
    // entire advertised wait.
    expect(waitLockMutationOptions(1800)).toEqual({ lockTimeoutMs: 1_800_000 });
  });

  it('yields an empty object when no budget applies', () => {
    // Spreadable unconditionally: assigning `lockTimeoutMs: undefined` is a
    // type error under exactOptionalPropertyTypes, and would also override
    // the default rather than defer to it.
    expect(waitLockMutationOptions(undefined)).toEqual({});
  });
});
