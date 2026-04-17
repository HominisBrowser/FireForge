// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../mach.js', () => ({
  ensureMach: vi.fn(() => Promise.resolve()),
}));

vi.mock('../mach-python.js', () => ({
  getPython: vi.fn(() => Promise.resolve('/usr/bin/python3')),
}));

vi.mock('node:fs/promises', () => ({
  mkdtemp: vi.fn(() => Promise.resolve('/tmp/fireforge-marionette-xyz')),
  rm: vi.fn(() => Promise.resolve()),
}));

import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { ensureMach } from '../mach.js';
import { reportMarionettePreflight, runMarionettePreflight } from '../marionette-preflight.js';

class MockStream extends EventEmitter {}

interface MockChild extends EventEmitter {
  stderr: MockStream | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stderr: new MockStream(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  });
}

interface MockSocket extends EventEmitter {
  destroy: ReturnType<typeof vi.fn>;
}

function makeSocket(): MockSocket {
  return Object.assign(new EventEmitter(), {
    destroy: vi.fn(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(pathExists).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('runMarionettePreflight', () => {
  it('reports PASS when the marionette socket delivers handshake bytes', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const socket = makeSocket();
    // Inject a spawner that returns the mock child so we do not actually
    // fork mach, and a connect factory that returns our scripted socket so
    // we can deterministically emit `connect` + `data`.
    const spawner = vi.fn(() => child) as never;
    const connect = vi.fn(() => {
      // Schedule the handshake once the preflight has attached its listeners.
      queueMicrotask(() => {
        socket.emit('connect');
        queueMicrotask(() => {
          socket.emit('data', Buffer.from('{"applicationType":"gecko"}\n'));
        });
      });
      return socket;
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 5_000,
    });

    // Drain microtasks and then the SIGTERM-grace delay in the teardown.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('Marionette handshake received');
    expect(spawner).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledWith({ host: '127.0.0.1', port: 54_321 });
    // Teardown: the helper sends SIGTERM (cooperative) before falling back.
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(socket.destroy).toHaveBeenCalled();
  });

  it('reports FAIL with the stderr tail when the socket never answers', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const sockets: MockSocket[] = [];
    const spawner = vi.fn(() => child) as never;
    // Each connect attempt gets a fresh socket — mirrors real net.createConnection
    // and ensures `once('error', ...)` is always registered before we emit.
    const connect = vi.fn(() => {
      const socket = makeSocket();
      sockets.push(socket);
      // Schedule the error on the next microtask so listeners have been
      // attached by the time we emit.
      queueMicrotask(() => {
        socket.emit('error', new Error('ECONNREFUSED'));
      });
      return socket;
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 50,
    });

    // Let the preflight reach the point where it has attached a `data`
    // listener to child.stderr before we emit — mkdtemp, ensureMach,
    // getPython, and the spawner call each park on a microtask.
    await vi.advanceTimersByTimeAsync(0);
    child.stderr?.emit('data', Buffer.from('failed to bind marionette: address in use\n'));

    // Advance past the retry-delay loop until the global budget expires,
    // then past the teardown grace timer.
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(800);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not respond within/);
    expect(result.detail).toContain('address in use');
    expect(sockets.length).toBeGreaterThanOrEqual(1);
  });

  it('escalates to SIGKILL when the child refuses SIGTERM', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const spawner = vi.fn(() => child) as never;
    const connect = vi.fn(() => {
      const socket = makeSocket();
      queueMicrotask(() => {
        socket.emit('error', new Error('ECONNREFUSED'));
      });
      return socket;
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 20,
    });

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(800);

    await promise;
    // Child never toggled exitCode/signalCode, so SIGKILL fires after the
    // 500 ms grace.
    const calls = child.kill.mock.calls.map((c): unknown => c[0]);
    expect(calls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reports FAIL distinctly when the browser exits before the handshake', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    const spawner = vi.fn(() => child) as never;
    // First attempt: child dies between connect() and the socket error.
    const connect = vi.fn(() => {
      const socket = makeSocket();
      queueMicrotask(() => {
        child.exitCode = 1;
        socket.emit('error', new Error('ECONNREFUSED'));
      });
      return socket;
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 5_000,
    });

    await vi.advanceTimersByTimeAsync(0);
    child.stderr?.emit('data', Buffer.from('mach bootstrap failed\n'));
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Browser process exited before marionette handshake');
    expect(result.detail).toContain('mach bootstrap failed');
  });

  it('short-circuits when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    const spawner = vi.fn() as never;
    const connect = vi.fn() as never;
    const result = await runMarionettePreflight('/missing-engine', {
      spawner,
      connect,
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Engine directory not found');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('surfaces an ensureMach failure as a FAIL diagnostic without spawning', async () => {
    vi.mocked(ensureMach).mockRejectedValueOnce(new Error('mach missing'));
    const spawner = vi.fn() as never;
    const connect = vi.fn() as never;

    const result = await runMarionettePreflight('/engine', { spawner, connect });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mach not available');
    expect(spawner).not.toHaveBeenCalled();
  });
});

describe('reportMarionettePreflight', () => {
  it('logs a PASS line via info', () => {
    reportMarionettePreflight({ ok: true, durationMs: 120, detail: 'handshake' });
    expect(info).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a FAIL line via warn', () => {
    reportMarionettePreflight({ ok: false, durationMs: 10_000, detail: 'timeout' });
    expect(warn).toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
