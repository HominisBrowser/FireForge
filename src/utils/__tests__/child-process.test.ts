// SPDX-License-Identifier: EUPL-1.2
import { ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { signalDirectChild } from '../child-process.js';

afterEach(() => vi.restoreAllMocks());

it('never invokes native kill for a real missing-executable spawn before or after its error', async () => {
  const child = spawn(join(import.meta.dirname, 'nonexistent-fireforge-executable'));
  const failed = once(child, 'error');
  // Keep the regression harmless even if the production guard is broken.
  const kill = vi.spyOn(child, 'kill').mockReturnValue(false);
  expect(child.pid).toBeUndefined();
  expect(signalDirectChild(child)).toBe(false);
  await failed;
  expect(signalDirectChild(child, 'SIGKILL')).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

it.each([undefined, 0, 1, -12, Number.NaN, 1.5])('refuses invalid child identity %s', (pid) => {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { value: pid });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  expect(signalDirectChild(child)).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

it.each([
  { exitCode: 0, signalCode: null },
  { exitCode: null, signalCode: 'SIGTERM' },
])('refuses already completed children: %j', (status) => {
  const child = new ChildProcess();
  Object.assign(child, { pid: 12345, ...status });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  expect(signalDirectChild(child)).toBe(false);
  expect(kill).not.toHaveBeenCalled();
});

it('signals the live owned native child handle and keeps failed cleanup best-effort', () => {
  const child = new ChildProcess();
  Object.assign(child, { pid: 12345 });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  expect(signalDirectChild(child, 'SIGINT')).toBe(true);
  expect(kill).toHaveBeenCalledExactlyOnceWith('SIGINT');
  kill.mockImplementation(() => {
    throw new Error('child no longer signalable');
  });
  expect(signalDirectChild(child)).toBe(false);
});
