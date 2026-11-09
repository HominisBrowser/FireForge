// SPDX-License-Identifier: EUPL-1.2
import { ChildProcess, spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { afterEach, beforeEach, expect, it, type MockInstance, vi } from 'vitest';

import type { AuthoredSnapshot } from '../../authored/types.js';
import { retainSnapshot } from '../retention.js';

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({ access: () => Promise.resolve() }));
vi.mock('../../authored/index.js', () => ({ authenticateAuthoredSnapshot: vi.fn() }));
beforeEach(() => vi.mocked(spawn).mockReset());
afterEach(() => vi.restoreAllMocks());

it.each([0, 1])(
  'never signals unidentified failed retention child %s while cleaning its owned peer',
  async (failed) => {
    const createChild = (
      index: number
    ): { child: ChildProcess; kill: MockInstance<ChildProcess['kill']> } => {
      const child = new ChildProcess();
      Object.assign(child, {
        pid: index === failed ? undefined : 12345,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const kill = vi.spyOn(child, 'kill').mockImplementation(() => {
        queueMicrotask(() => child.emit('exit', null, 'SIGTERM'));
        return true;
      });
      return { child, kill };
    };
    const pack = createChild(0),
      unpack = createChild(1);
    const failedChild = failed === 0 ? pack : unpack;
    const ownedChild = failed === 0 ? unpack : pack;
    vi.mocked(spawn)
      .mockImplementationOnce(() => pack.child)
      .mockImplementationOnce(() => unpack.child);
    const snapshot = {
      objectFormat: 'sha1',
      tree: 'tree',
      repository: '/editor',
      id: 'source',
    } as AuthoredSnapshot;
    const result = retainSnapshot('/namespace', snapshot, '/pristine');
    // retainSnapshot first awaits its repository check before launching both children.
    await vi.waitFor(() => {
      expect(spawn).toHaveBeenCalledTimes(2);
    });
    failedChild.child.emit('error', new Error('spawn git ENOENT'));
    await expect(result).rejects.toThrow('ENOENT');
    expect(failedChild.kill).not.toHaveBeenCalled();
    expect(ownedChild.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    for (const { child } of [pack, unpack]) {
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
  }
);
