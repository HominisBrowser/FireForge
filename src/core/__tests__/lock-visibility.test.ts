// SPDX-License-Identifier: EUPL-1.2
/**
 * The engine-session lock was correct but INVISIBLE. Operators under
 * several concurrent sessions inferred queue state from `ps` and their own
 * wait lines.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { formatEngineSessionLockStatus } from '../engine-session-lock.js';
import { readLockQueue, readLockStatus, withFileLock } from '../file-lock.js';

describe('readLockStatus', () => {
  let dir: string;
  let lockPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ff-lockvis-'));
    lockPath = join(dir, 'engine-session.lock');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports a free lock without acquiring it', async () => {
    const snapshot = await readLockStatus(lockPath);
    expect(snapshot).toEqual({ held: false, queueDepth: 0 });
    expect(formatEngineSessionLockStatus(snapshot)[0]).toContain('free');
  });

  it('names the holder, its command, and the hold duration while held', async () => {
    await withFileLock(
      lockPath,
      async () => {
        const snapshot = await readLockStatus(lockPath);
        expect(snapshot.held).toBe(true);
        expect(snapshot.holder?.pid).toBe(process.pid);
        expect(snapshot.holder?.alive).toBe(true);
        expect(snapshot.holder?.metadata).toContain('command=build');
        expect(snapshot.heldForMs).toBeGreaterThanOrEqual(0);

        const lines = formatEngineSessionLockStatus(snapshot);
        expect(lines[0]).toContain(`PID ${String(process.pid)}`);
        expect(lines[0]).toContain('command=build');
        expect(lines[1]).toContain('Queue depth: 0');
        return undefined;
      },
      { ownerMetadata: ['command=build', 'started=2026-08-20T00:00:00.000Z'] }
    );
  });

  it('counts a real concurrent waiter in the queue depth', async () => {
    let observedDepth = -1;
    await withFileLock(
      lockPath,
      async () => {
        // A genuine second acquirer: it contends, registers itself in the
        // waiter queue, and eventually times out.
        const waiter = withFileLock(lockPath, () => Promise.resolve(), {
          timeoutMs: 1_500,
          pollMs: 25,
        }).catch(() => undefined);

        // Poll until the waiter has advertised itself.
        for (let i = 0; i < 60 && observedDepth < 1; i += 1) {
          observedDepth = (await readLockQueue(lockPath)).depth;
          if (observedDepth < 1) await new Promise((r) => setTimeout(r, 25));
        }
        const snapshot = await readLockStatus(lockPath);
        expect(snapshot.queueDepth).toBeGreaterThanOrEqual(1);
        expect(formatEngineSessionLockStatus(snapshot)[1]).toContain('waiter(s)');
        await waiter;
        return undefined;
      },
      { ownerMetadata: ['command=test'] }
    );

    expect(observedDepth).toBeGreaterThanOrEqual(1);
    // The waiter deregisters when it stops waiting, so the queue drains.
    await expect(readLockQueue(lockPath)).resolves.toEqual({ depth: 0, ahead: 0 });
  });

  it('flags a lock whose owner process is gone as stale', () => {
    const lines = formatEngineSessionLockStatus({
      held: true,
      holder: { pid: 999999, alive: false, metadata: ['command=build'] },
      heldForMs: 42_000,
      queueDepth: 2,
    });
    expect(lines[0]).toContain('NOT RUNNING');
    expect(lines[0]).toContain('42s');
    expect(lines[1]).toContain('2 waiter(s)');
  });
});
