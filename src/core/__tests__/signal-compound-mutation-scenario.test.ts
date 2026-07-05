// SPDX-License-Identifier: EUPL-1.2
/**
 * Scenario tests for a signal landing during a COMPOUND mutation. The unit
 * suites (`furnace-operation.test.ts`, `signal-critical.test.ts`,
 * `file-lock.test.ts`) pin each lifecycle module alone; these tests pin the
 * cross-module behavior as `bin/fireforge.ts` actually composes it —
 * `Promise.allSettled` of furnace rollback + critical-section drain, then
 * furnace lock force-release, then (simulated) `process.exit`. See
 * docs/lifecycle-invariants.md for the invariants under test:
 *
 *  1. exit is held until an in-flight "engine apply + state persist" pair
 *     finishes, so bookkeeping can never be left stale relative to the engine;
 *  2. the hold is bounded — a stuck section cannot postpone exit forever;
 *  3. furnace rollback and the critical-section drain compose: the engine
 *     file is restored, the state write still completes, and the furnace
 *     lock is force-released before exit.
 */
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../furnace-config.js', () => ({
  loadFurnaceState: vi.fn((): Promise<Record<string, unknown>> => Promise.resolve({})),
  updateFurnaceState: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
}));

import {
  __resetFurnaceOperationStateForTests,
  forceReleaseFurnaceLocksForActiveOperations,
  getFurnaceLockPath,
  rollbackActiveOperationsForSignal,
  runFurnaceMutation,
} from '../furnace-operation.js';
import { createRollbackJournal, snapshotFile } from '../furnace-rollback.js';
import { runInSignalCriticalSection, waitForActiveCriticalSections } from '../signal-critical.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  __resetFurnaceOperationStateForTests();
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Replicates the SIGINT/SIGTERM pipeline from `bin/fireforge.ts` up to (but
 * not including) `process.exit`. Kept structurally identical to the handler
 * so a drift in the bin wiring shows up as a drift from this scenario.
 */
async function simulateBinSignalHandler(criticalSectionTimeoutMs: number): Promise<void> {
  await Promise.allSettled([
    rollbackActiveOperationsForSignal('SIGINT').catch(() => undefined),
    waitForActiveCriticalSections(criticalSectionTimeoutMs),
  ]);
  await forceReleaseFurnaceLocksForActiveOperations();
}

describe('signal during a compound mutation (bin-handler composition)', () => {
  it('holds exit until an in-flight apply + state persist pair completes', async () => {
    const root = await makeTempProject('ff-signal-scenario-');
    const engineFile = join(root, 'engine-file.txt');
    const sessionFile = join(root, 'session.json');

    // Compound mutation: engine write, then — after the gate, where the
    // simulated signal lands — the bookkeeping write that must not be lost.
    const gate = deferred();
    const section = runInSignalCriticalSection('rebase apply + session persist', async () => {
      await writeFile(engineFile, 'patched');
      await gate.promise;
      await writeFile(sessionFile, '{"applied":1}');
    });

    let exited = false;
    const handler = simulateBinSignalHandler(10_000).then(() => {
      exited = true;
    });

    // Give the handler a full macrotask to (incorrectly) race ahead: it must
    // still be blocked on the open critical section.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(exited).toBe(false);
    expect(await pathExistsOnDisk(sessionFile)).toBe(false);

    gate.resolve();
    await section;
    await handler;

    expect(exited).toBe(true);
    await expect(readFile(sessionFile, 'utf8')).resolves.toBe('{"applied":1}');
  });

  it('does not postpone exit indefinitely when a section is stuck', async () => {
    const gate = deferred();
    const section = runInSignalCriticalSection('stuck section', () => gate.promise);

    const start = Date.now();
    await simulateBinSignalHandler(100);
    expect(Date.now() - start).toBeLessThan(5_000);

    // Unstick and drain so the section does not leak into other tests.
    gate.resolve();
    await section;
  });

  it('composes furnace rollback, the critical-section drain, and lock force-release', async () => {
    const root = await makeTempProject('ff-signal-scenario-furnace-');
    const engineFile = join(root, 'engine-file.txt');
    const sessionFile = join(root, 'session.json');
    await writeFile(engineFile, 'pristine');

    // A furnace mutation mid-flight: journal captured, engine mutated,
    // body held open — the shape at the moment a signal arrives.
    const bodyGate = deferred();
    const bodyReady = deferred();
    const runPromise = runFurnaceMutation(root, 'apply-rollback', async (ctx) => {
      const journal = createRollbackJournal();
      ctx.registerJournal(journal);
      await snapshotFile(journal, engineFile);
      await writeFile(engineFile, 'corrupted');
      bodyReady.resolve();
      await bodyGate.promise;
      return 'done';
    });
    await bodyReady.promise;
    expect(await pathExistsOnDisk(getFurnaceLockPath(root))).toBe(true);

    // Simultaneously, a critical section is mid-way through its state write.
    const sectionGate = deferred();
    const section = runInSignalCriticalSection('session persist', async () => {
      await sectionGate.promise;
      await writeFile(sessionFile, 'persisted');
    });

    const handler = simulateBinSignalHandler(10_000);
    sectionGate.resolve();
    await section;
    await handler;

    // Rollback restored the engine, the state write completed anyway, and
    // the furnace lock is gone before the (simulated) exit.
    expect(await readFile(engineFile, 'utf8')).toBe('pristine');
    expect(await readFile(sessionFile, 'utf8')).toBe('persisted');
    expect(await pathExistsOnDisk(getFurnaceLockPath(root))).toBe(false);

    bodyGate.resolve();
    await runPromise;
  });
});
