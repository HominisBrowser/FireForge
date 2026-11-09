// SPDX-License-Identifier: EUPL-1.2
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ensureSupervisor } from '../client.js';
import { readJson } from '../store.js';

const fixture = vi.hoisted(() => ({
  close: vi.fn(() => Promise.resolve()),
  connect: vi.fn(),
}));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  open: vi.fn(() => Promise.resolve({ fd: 42, close: fixture.close })),
}));
vi.mock('../source-loader.js', async (original) => ({
  ...(await original<typeof import('../source-loader.js')>()),
  assertSourceLoaderEnvironment: vi.fn(),
}));
vi.mock('node:net', async (original) => ({
  ...(await original<typeof import('node:net')>()),
  connect: fixture.connect,
}));
vi.mock('../store.js', () => ({
  ensurePrivateNamespace: vi.fn(() => Promise.resolve()),
  readJson: vi.fn(),
  readJournal: vi.fn(),
  writeDurable: vi.fn(),
}));
let child: ChildProcess;
let unref: ReturnType<typeof vi.fn>;
let rawKill: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readJson).mockImplementation((path) =>
    path.endsWith('config.json')
      ? Promise.resolve({ runtime: { node: process.execPath, environment: {} } })
      : path.endsWith('current.json')
        ? // No pinned build: the supervisor starts from this client's package.
          Promise.reject(Object.assign(new Error('no pinned build'), { code: 'ENOENT' }))
        : Promise.reject(new Error('not published'))
  );
  unref = vi.fn();
  rawKill = vi.fn();
  child = Object.assign(new ChildProcess(), { unref, kill: rawKill });
});
afterEach(() => {
  vi.restoreAllMocks();
});

it('turns an asynchronous no-PID spawn error into a caught refusal and closes its log', async () => {
  const error = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
  vi.mocked(spawn).mockImplementation(() => {
    queueMicrotask(() => child.emit('error', error));
    return child;
  });
  const refusal: unknown = await ensureSupervisor('/private/coordinator').catch(
    (caught: unknown) => caught
  );
  expect(refusal).toBeInstanceOf(Error);
  expect((refusal as Error).message).toContain('could not be spawned');
  expect((refusal as Error).cause).toBe(error);
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(unref).not.toHaveBeenCalled();
  expect(rawKill).not.toHaveBeenCalled();
});
it('closes the log and preserves a synchronous spawn failure cause', async () => {
  const error = new Error('spawn denied');
  vi.mocked(spawn).mockImplementation(() => {
    throw error;
  });
  await expect(ensureSupervisor('/private/coordinator')).rejects.toMatchObject({ cause: error });
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(rawKill).not.toHaveBeenCalled();
});
it('unrefs only a positively spawned supervisor before observing its published endpoint', async () => {
  const endpoint = { socket: '/private/socket', epoch: 1, owner: { pid: 1234, start: 'birth' } };
  let published = false;
  vi.mocked(readJson).mockImplementation((path) =>
    path.endsWith('config.json')
      ? Promise.resolve({ runtime: { node: process.execPath, environment: {} } })
      : path.endsWith('current.json')
        ? Promise.reject(Object.assign(new Error('no pinned build'), { code: 'ENOENT' }))
        : published
          ? Promise.resolve(endpoint)
          : Promise.reject(new Error('not published'))
  );
  fixture.connect.mockImplementation(() => {
    const probe = Object.assign(new EventEmitter(), {
      setTimeout: vi.fn(),
      destroy: vi.fn(),
    });
    queueMicrotask(() => probe.emit('connect'));
    return probe;
  });
  vi.mocked(spawn).mockImplementation(() => {
    expect(unref).not.toHaveBeenCalled();
    queueMicrotask(() => child.emit('spawn'));
    published = true;
    return child;
  });
  await expect(ensureSupervisor('/private/coordinator')).resolves.toEqual(endpoint);
  expect(unref).toHaveBeenCalledOnce();
  expect(fixture.close).toHaveBeenCalledOnce();
  expect(rawKill).not.toHaveBeenCalled();
});
