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

import { mkdtemp } from 'node:fs/promises';

import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { ensureMach } from '../mach.js';
import { getPython } from '../mach-python.js';
import { reportMarionettePreflight, runMarionettePreflight } from '../marionette-preflight.js';

class MockStream extends EventEmitter {
  // Matches Node's `Readable.destroy()` well enough for the preflight
  // cleanup path — it's called unconditionally when the preflight finally
  // block runs, so the stub must be a real function.
  destroy = vi.fn();
}

interface MockChild extends EventEmitter {
  stderr: MockStream | null;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  pid?: number;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): MockChild {
  return Object.assign(new EventEmitter(), {
    stderr: new MockStream(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    // A non-zero pid lets the preflight exercise the process-group kill
    // branch (`process.kill(-pid, …)`) that was added to stop Firefox
    // grandchildren from keeping the stderr pipe alive after PASS.
    pid: 4242,
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
      spawnSettleMs: 0,
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
      spawnSettleMs: 0,
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
    expect(result.detail).toContain('[layer 6/6: marionette-handshake]');
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
      spawnSettleMs: 0,
    });

    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(800);

    await promise;
    // Child never toggled exitCode/signalCode, so SIGKILL fires after the
    // 500 ms grace. The process-group kill (`process.kill(-pid, …)`)
    // happens via the module's killProcessGroup helper, which falls back
    // to `child.kill` on unsupported environments; the test platform is
    // non-win32 AND has a pid on the child, so the fallback only fires
    // when process.kill throws (which it will here because pid 4242 is
    // fake). Either way, `child.kill` must have been called with both
    // signals in order — that's the escalation contract.
    const calls = child.kill.mock.calls.map((c): unknown => c[0]);
    expect(calls).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('destroys the stderr pipe in the finally block', async () => {
    // Eval regression: Firefox (grandchild of the Python mach wrapper)
    // inherited the stderr pipe FD and kept Node's event loop alive after
    // a passing preflight — `fireforge test --doctor` printed PASS and
    // then hung indefinitely in `uv__io_poll`. The fix destroys the
    // stderr stream in the finally block so the local end of the pipe
    // closes regardless of what the grandchild does with its inherited
    // handle.
    vi.useFakeTimers();
    const child = makeChild();
    const stderr = child.stderr;
    const spawner = vi.fn(() => child) as never;
    const connect = vi.fn(() => {
      const socket = makeSocket();
      queueMicrotask(() => {
        socket.emit('connect');
        socket.emit('data', Buffer.from('hello'));
      });
      return socket;
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 200,
      spawnSettleMs: 0,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Mark child as exited so the finally branch skips the SIGTERM/SIGKILL
    // dance and proceeds straight to the stderr destroy + profile
    // cleanup path.
    child.exitCode = 0;
    await vi.advanceTimersByTimeAsync(600);

    await promise;
    expect(stderr?.destroy).toHaveBeenCalled();
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
      spawnSettleMs: 0,
    });

    await vi.advanceTimersByTimeAsync(0);
    child.stderr?.emit('data', Buffer.from('mach bootstrap failed\n'));
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('Browser process exited before marionette handshake');
    expect(result.detail).toContain('mach bootstrap failed');
    expect(result.detail).toContain('[layer 6/6: marionette-handshake]');
  });

  it('fails at layer 5 when the browser crashes within the spawn settle window', async () => {
    vi.useFakeTimers();
    const child = makeChild();
    // Child is returned alive, but flips to exited before the settle timer
    // elapses. This is the scenario where Gecko aborts at startup because
    // of a missing dylib, wrong CPU arch, or corrupt profile — the socket
    // poll would otherwise swallow the full budget waiting for bytes.
    const spawner = vi.fn(() => {
      queueMicrotask(() => {
        child.exitCode = 127;
      });
      return child;
    }) as never;
    const connect = vi.fn(() => {
      throw new Error('connect should not be reached — layer 5 must short-circuit');
    }) as never;

    const promise = runMarionettePreflight('/engine', {
      spawner,
      connect,
      port: 54_321,
      timeoutMs: 30_000,
      spawnSettleMs: 250,
    });

    await vi.advanceTimersByTimeAsync(0);
    child.stderr?.emit('data', Buffer.from('Error: libXRender.so.1 not found\n'));
    // Advance past the settle window and the teardown grace.
    await vi.advanceTimersByTimeAsync(260);
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('[layer 5/6: browser-spawns]');
    expect(result.detail).toContain('Browser process exited during spawn');
    expect(result.detail).toContain('libXRender');
    expect(connect).not.toHaveBeenCalled();
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
    expect(result.detail).toContain('[layer 1/6: engine-present]');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('surfaces an ensureMach failure as a FAIL diagnostic without spawning', async () => {
    vi.mocked(ensureMach).mockRejectedValueOnce(new Error('mach missing'));
    const spawner = vi.fn() as never;
    const connect = vi.fn() as never;

    const result = await runMarionettePreflight('/engine', { spawner, connect });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('mach not available');
    expect(result.detail).toContain('[layer 2/6: mach-available]');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('fails at layer 3 when Python cannot be resolved', async () => {
    vi.mocked(getPython).mockRejectedValueOnce(new Error('python3 not on PATH'));
    const spawner = vi.fn() as never;
    const connect = vi.fn() as never;

    const result = await runMarionettePreflight('/engine', { spawner, connect });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('[layer 3/6: python-available]');
    expect(result.detail).toContain('python3 not on PATH');
    expect(spawner).not.toHaveBeenCalled();
  });

  it('fails at layer 4 when the throwaway profile cannot be created', async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('EACCES: no write access to tmp'));
    const spawner = vi.fn() as never;
    const connect = vi.fn() as never;

    const result = await runMarionettePreflight('/engine', { spawner, connect });

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('[layer 4/6: profile-creatable]');
    expect(result.detail).toContain('EACCES');
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
