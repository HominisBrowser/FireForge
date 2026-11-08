// SPDX-License-Identifier: EUPL-1.2
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import { readLockStatus } from '../file-lock.js';
import * as furnaceState from '../furnace-config.js';
import {
  __resetFurnaceOperationStateForTests,
  completeJournalRollback,
  getFurnaceLockPath,
  rollbackActiveOperationsForSignal,
  runFurnaceMutation,
} from '../furnace-operation.js';
import { createRollbackJournal, snapshotFile } from '../furnace-rollback.js';

vi.mock('../../utils/logger.js', async () => {
  const { createLoggerMock } = await import('../../test-utils/module-mocks.js');
  return createLoggerMock();
});
vi.mock('node:fs/promises', async (original) => {
  const module = await original<typeof import('node:fs/promises')>();
  return { ...module, rename: vi.fn(module.rename) };
});
function barrier(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {
    throw new Error('barrier not ready');
  };
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('A07 mutation serialization and shutdown joins', () => {
  let root: string;
  beforeEach(async () => {
    root = await createTempProject('fireforge-a07-transaction-');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    __resetFurnaceOperationStateForTests();
    await removeTempProject(root);
  });

  it('refuses a waiter when the preceding holder records pending repair after its outer preflight', async () => {
    const entered = barrier(),
      release = barrier(),
      checked = barrier();
    const holder = runFurnaceMutation(root, 'apply-rollback', async () => {
      entered.resolve();
      await release.promise;
      await furnaceState.updateFurnaceState(root, (state) => ({
        ...state,
        pendingRepair: {
          operation: 'apply-rollback',
          timestamp: new Date().toISOString(),
          reason: 'incomplete preceding restore',
        },
      }));
    });
    await entered.promise;
    const actual = furnaceState.loadFurnaceState;
    vi.spyOn(furnaceState, 'loadFurnaceState').mockImplementation(async (path) => {
      const state = await actual(path);
      if (!state.pendingRepair) checked.resolve();
      return state;
    });
    let mutated = false;
    const waiter = runFurnaceMutation(root, 'create-rollback', () => {
      mutated = true;
      return Promise.resolve();
    });
    const refused = expect(waiter).rejects.toThrow('inconsistent');
    await checked.promise;
    release.resolve();
    await holder;
    await refused;
    expect(mutated).toBe(false);
    expect((await actual(root)).pendingRepair?.reason).toBe('incomplete preceding restore');
  });

  it.each(['throw-path', 'body-owned'])(
    'joins an actual %s restore before signal shutdown and lock release',
    async (mode) => {
      const sentinel = join(root, 'sentinel.txt');
      await filesystem.writeFile(sentinel, 'pristine');
      const restoring = barrier(),
        release = barrier();
      const { rename } =
        await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      let publications = 0;
      vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
        if (to === sentinel && String(from).includes('.rollback-')) {
          publications++;
          restoring.resolve();
          await release.promise;
        }
        await rename(from, to);
      });
      const operation = runFurnaceMutation(root, 'rename-rollback', async (ctx) => {
        const journal = createRollbackJournal();
        ctx.registerJournal(journal);
        await snapshotFile(journal, sentinel);
        await filesystem.writeFile(sentinel, 'corrupted');
        if (mode === 'body-owned')
          return completeJournalRollback(ctx, journal, new Error('primary failure'), {
            projectRoot: root,
            operation: 'rename-rollback',
            failureMessage: 'rename failed',
            subject: 'fixture',
          });
        throw new Error('primary failure');
      });
      const failed = expect(operation).rejects.toThrow('primary failure');
      await restoring.promise;
      let shutdownDone = false;
      const shutdown = rollbackActiveOperationsForSignal('SIGTERM').then(() => {
        shutdownDone = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(shutdownDone).toBe(false);
      expect((await readLockStatus(getFurnaceLockPath(root))).held).toBe(true);
      release.resolve();
      await shutdown;
      await failed;
      expect(publications).toBe(1);
      expect(await filesystem.readFile(sentinel, 'utf8')).toBe('pristine');
      expect((await furnaceState.loadFurnaceState(root)).pendingRepair).toBeUndefined();
      expect((await readLockStatus(getFurnaceLockPath(root))).held).toBe(false);
    }
  );
});
