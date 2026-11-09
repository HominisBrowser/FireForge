// SPDX-License-Identifier: EUPL-1.2
/**
 * A furnace mutation made of several independent units (a named deploy of
 * several components) keeps one rollback journal per unit: each failing unit
 * restores its own journal, and a committed unit survives a later failure or
 * signal. Real files, real furnace state, no mocks of the lifecycle.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { loadFurnaceState } from '../furnace-config.js';
import {
  __resetFurnaceOperationStateForTests,
  adoptCrashedFurnaceMutation,
  type FurnaceOperationContext,
  rollbackActiveOperationsForSignal,
  runFurnaceMutation,
  runFurnaceRollback,
} from '../furnace-operation.js';
import {
  createRollbackJournal,
  restoreRollbackJournalOrThrow,
  snapshotFile,
} from '../furnace-rollback.js';

let root: string;

beforeEach(async () => {
  __resetFurnaceOperationStateForTests();
  root = await mkdtemp(join(tmpdir(), 'ff-furnace-units-'));
  await mkdir(join(root, '.fireforge'), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Registers a unit journal that snapshots then overwrites one file. */
async function mutateUnit(
  ctx: FurnaceOperationContext,
  file: string
): Promise<() => Promise<void>> {
  const journal = createRollbackJournal();
  ctx.registerJournal(journal);
  await snapshotFile(journal, file);
  await writeFile(file, 'torn');
  return () => restoreRollbackJournalOrThrow(journal, 'unit failed');
}

describe('per-unit rollback in one mutation', () => {
  it('restores the second failing unit as well as the first', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'a-pristine');
    await writeFile(b, 'b-pristine');

    await runFurnaceMutation(root, 'deploy-rollback', async (ctx) => {
      await runFurnaceRollback(ctx, await mutateUnit(ctx, a));
      await runFurnaceRollback(ctx, await mutateUnit(ctx, b));
    });

    expect(await readFile(a, 'utf8')).toBe('a-pristine');
    expect(await readFile(b, 'utf8')).toBe('b-pristine');
  });

  it('does not restore a committed unit when a later unit throws before its journal', async () => {
    const a = join(root, 'a.txt');
    await writeFile(a, 'a-pristine');
    const failure = new Error('second unit refused in pre-flight');

    await expect(
      runFurnaceMutation(root, 'deploy-rollback', async (ctx) => {
        await mutateUnit(ctx, a);
        await writeFile(a, 'a-deployed');
        ctx.commitJournal();
        throw failure;
      })
    ).rejects.toBe(failure);

    expect(await readFile(a, 'utf8')).toBe('a-deployed');
  });

  it('does not restore a committed unit on a signal between units', async () => {
    const a = join(root, 'a.txt');
    await writeFile(a, 'a-pristine');
    let committed: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      committed = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runFurnaceMutation(root, 'deploy-rollback', async (ctx) => {
      await mutateUnit(ctx, a);
      await writeFile(a, 'a-deployed');
      ctx.commitJournal();
      committed();
      await held;
    });
    await reached;
    await rollbackActiveOperationsForSignal('SIGINT');
    release();
    await run;

    expect(await readFile(a, 'utf8')).toBe('a-deployed');
  });

  it('restores the second unit on a signal after the first unit already rolled back', async () => {
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    await writeFile(a, 'a-pristine');
    await writeFile(b, 'b-pristine');
    let ready: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const run = runFurnaceMutation(root, 'deploy-rollback', async (ctx) => {
      await runFurnaceRollback(ctx, await mutateUnit(ctx, a));
      await mutateUnit(ctx, b);
      ready();
      await held;
    });
    await reached;
    await rollbackActiveOperationsForSignal('SIGTERM');
    release();
    await run;

    expect(await readFile(a, 'utf8')).toBe('a-pristine');
    expect(await readFile(b, 'utf8')).toBe('b-pristine');
  });
});

describe('crash marker for non-idempotent operations', () => {
  /** A pid that belonged to a process that has exited. */
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid ?? 0;
    await new Promise((resolve) => child.once('exit', resolve));
    return pid;
  }

  it('keeps a sidecar while an authoring operation runs and removes it on exit', async () => {
    const sidecar = join(root, '.fireforge', 'furnace-inflight.json');
    await runFurnaceMutation(root, 'create-rollback', async () => {
      const record = JSON.parse(await readFile(sidecar, 'utf8')) as { operation: string };
      expect(record.operation).toBe('create-rollback');
    });
    await expect(readFile(sidecar, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps no sidecar for idempotent apply and deploy', async () => {
    const sidecar = join(root, '.fireforge', 'furnace-inflight.json');
    for (const kind of ['apply-rollback', 'deploy-rollback'] as const) {
      await runFurnaceMutation(root, kind, async () => {
        await expect(readFile(sidecar, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      });
    }
  });

  it('removes the sidecar when the body throws and rolls back cleanly', async () => {
    await expect(
      runFurnaceMutation(root, 'remove-rollback', () => Promise.reject(new Error('refused')))
    ).rejects.toThrow('refused');
    await expect(
      readFile(join(root, '.fireforge', 'furnace-inflight.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await loadFurnaceState(root)).pendingRepair).toBeUndefined();
  });

  it('turns the sidecar of a killed process into a repair marker that refuses the next mutation', async () => {
    const pid = await deadPid();
    await writeFile(
      join(root, '.fireforge', 'furnace-inflight.json'),
      JSON.stringify({ operation: 'rename-rollback', pid, startedAt: '2026-01-01T00:00:00.000Z' })
    );

    await expect(
      runFurnaceMutation(root, 'create-rollback', () => Promise.resolve('ran'))
    ).rejects.toThrow(/previous "rename-rollback".*pid \d+.*ended before it finished/s);

    const { pendingRepair } = await loadFurnaceState(root);
    expect(pendingRepair?.operation).toBe('rename-rollback');
    await expect(
      readFile(join(root, '.fireforge', 'furnace-inflight.json'), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('lets doctor adopt a crashed sidecar only while the furnace lock is free', async () => {
    const pid = await deadPid();
    const sidecar = join(root, '.fireforge', 'furnace-inflight.json');
    let adoptedWhileHeld: boolean | undefined;
    await runFurnaceMutation(root, 'create-rollback', async () => {
      // A live mutation's own sidecar must not be adopted.
      adoptedWhileHeld = await adoptCrashedFurnaceMutation(root, false);
    });
    expect(adoptedWhileHeld).toBe(false);
    expect((await loadFurnaceState(root)).pendingRepair).toBeUndefined();

    await writeFile(
      sidecar,
      JSON.stringify({ operation: 'remove-rollback', pid, startedAt: '2026-01-01T00:00:00.000Z' })
    );
    await expect(adoptCrashedFurnaceMutation(root, false)).resolves.toBe(true);
    expect((await loadFurnaceState(root)).pendingRepair?.operation).toBe('remove-rollback');
  });
});
