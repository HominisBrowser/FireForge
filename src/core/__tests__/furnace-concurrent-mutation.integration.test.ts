// SPDX-License-Identifier: EUPL-1.2
/**
 * D12: Tests concurrent furnace mutations to verify the file lock
 * correctly serialises competing operations.
 */
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());

import { withFileLock } from '../file-lock.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
  vi.clearAllMocks();
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = join(tmpdir(), `fireforge-test-${prefix}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  cleanupPaths.push(dir);
  return dir;
}

describe('concurrent furnace mutations', () => {
  it('serialises two competing operations on the same lock path', async () => {
    const tempDir = await makeTempDir('concurrent-serial');
    const lockPath = join(tempDir, 'furnace.lock');
    const executionOrder: string[] = [];

    const op1 = withFileLock(
      lockPath,
      async () => {
        executionOrder.push('op1-start');
        await new Promise((resolve) => setTimeout(resolve, 80));
        executionOrder.push('op1-end');
        return 'result1';
      },
      { timeoutMs: 2000, pollMs: 10, staleMs: 60_000 }
    );

    // Small delay so op1 acquires the lock first
    await new Promise((resolve) => setTimeout(resolve, 5));

    const op2 = withFileLock(
      lockPath,
      () => {
        executionOrder.push('op2-start');
        return Promise.resolve('result2');
      },
      { timeoutMs: 2000, pollMs: 10, staleMs: 60_000 }
    );

    const [result1, result2] = await Promise.all([op1, op2]);

    expect(result1).toBe('result1');
    expect(result2).toBe('result2');
    // op2 must not start until op1 finishes
    expect(executionOrder).toEqual(['op1-start', 'op1-end', 'op2-start']);
  });

  it('second operation times out when the first holds the lock too long', async () => {
    const tempDir = await makeTempDir('concurrent-timeout');
    const lockPath = join(tempDir, 'furnace.lock');

    const op1 = withFileLock(
      lockPath,
      async () => {
        // Hold the lock longer than op2's timeout
        await new Promise((resolve) => setTimeout(resolve, 200));
        return 'held';
      },
      { timeoutMs: 2000, pollMs: 10, staleMs: 60_000 }
    );

    await new Promise((resolve) => setTimeout(resolve, 5));

    const op2 = withFileLock(lockPath, () => Promise.resolve('unreachable'), {
      timeoutMs: 50,
      pollMs: 5,
      staleMs: 60_000,
      onTimeoutMessage: 'Another furnace operation is running',
    });

    const [result1, error] = await Promise.allSettled([op1, op2]);

    expect(result1).toEqual({ status: 'fulfilled', value: 'held' });
    expect(error.status).toBe('rejected');
    if (error.status === 'rejected') {
      // The caller's copy leads, and withFileLock appends the holder
      // identification from the lock's owner metadata.
      expect((error.reason as Error).message).toMatch(
        /^Another furnace operation is running( The lock is held by PID \d+.*)?$/
      );
    }
  });

  it('allows parallel operations on different lock paths', async () => {
    const tempDir = await makeTempDir('concurrent-parallel');
    const lockPath1 = join(tempDir, 'furnace1.lock');
    const lockPath2 = join(tempDir, 'furnace2.lock');
    const executionOrder: string[] = [];

    const op1 = withFileLock(
      lockPath1,
      async () => {
        executionOrder.push('op1-start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        executionOrder.push('op1-end');
        return 'result1';
      },
      { timeoutMs: 2000, pollMs: 10, staleMs: 60_000 }
    );

    const op2 = withFileLock(
      lockPath2,
      async () => {
        executionOrder.push('op2-start');
        await new Promise((resolve) => setTimeout(resolve, 40));
        executionOrder.push('op2-end');
        return 'result2';
      },
      { timeoutMs: 2000, pollMs: 10, staleMs: 60_000 }
    );

    const [result1, result2] = await Promise.all([op1, op2]);

    expect(result1).toBe('result1');
    expect(result2).toBe('result2');
    // Both should overlap: both starts must occur before both ends.
    // We do not assert which operation starts first because the OS
    // scheduler is free to run either callback first when both are
    // launched concurrently via Promise.all.
    const op1StartIdx = executionOrder.indexOf('op1-start');
    const op2StartIdx = executionOrder.indexOf('op2-start');
    const op1EndIdx = executionOrder.indexOf('op1-end');
    const op2EndIdx = executionOrder.indexOf('op2-end');
    const firstEnd = Math.min(op1EndIdx, op2EndIdx);
    expect(op1StartIdx).toBeLessThan(firstEnd);
    expect(op2StartIdx).toBeLessThan(firstEnd);
  });
});
