// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exec, execInherit, execInheritCapture, execStream } from '../process.js';

class MockStream extends EventEmitter {}

interface MockChildProcess extends EventEmitter {
  stdout: MockStream;
  stderr: MockStream;
  kill: (signal?: NodeJS.Signals) => boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

function makeChild(): MockChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdout: new MockStream(),
    stderr: new MockStream(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn() as unknown as (signal?: NodeJS.Signals) => boolean,
  });
  return child;
}

describe('exec', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures stdout and stderr with the exit code', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hello']);
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.stderr.emit('data', Buffer.from('warning\n'));
    child.emit('close', 3);

    await expect(promise).resolves.toEqual({
      stdout: 'hello\n',
      stderr: 'warning\n',
      exitCode: 3,
    });
  });

  it('truncates oversized stdout safely', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hello']);
    child.stdout.emit('data', Buffer.from('a'.repeat(50 * 1024 * 1024 + 128)));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toContain('[truncated — output exceeded 50 MB]');
    expect(result.exitCode).toBe(0);
  });

  it('maps SIGINT termination to exit code 130', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hello']);
    child.emit('close', null, 'SIGINT');

    await expect(promise).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 130,
    });
  });
});

describe('execStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps SIGTERM termination to exit code 143', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = execStream('echo', ['hello']);
    child.emit('close', null, 'SIGTERM');

    await expect(promise).resolves.toBe(143);
  });
});

describe('execInherit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves normal exit codes from inherited child processes', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = execInherit('echo', ['hello']);
    child.emit('close', 7, null);

    await expect(promise).resolves.toBe(7);
  });

  it('forwards SIGINT to the child as SIGTERM and resolves once the child closes', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = execInherit('long-running', [], { shutdownGraceMs: 50 });
    // Parent receives SIGINT — helper should kill the child with SIGTERM, not
    // synchronously exit the Node process.
    process.emit('SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Cooperative child exits promptly on SIGTERM.
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toBe(128 + 15);
  });

  it('escalates to SIGKILL after the grace window if the child does not exit', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mockSpawn.mockReturnValue(child);
      const promise = execInherit('stubborn', [], { shutdownGraceMs: 50 });

      process.emit('SIGINT');
      expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');

      vi.advanceTimersByTime(100);
      expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

      child.emit('close', null, 'SIGKILL');
      await expect(promise).resolves.toBe(128 + 9);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes its signal listeners on close so repeated calls do not leak handlers', async () => {
    const baselineSigint = process.listenerCount('SIGINT');
    const baselineSigterm = process.listenerCount('SIGTERM');

    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = execInherit('echo', ['hello']);

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint + 1);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm + 1);

    child.emit('close', 0, null);
    await promise;

    expect(process.listenerCount('SIGINT')).toBe(baselineSigint);
    expect(process.listenerCount('SIGTERM')).toBe(baselineSigterm);
  });
});

describe('execInheritCapture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('streams and captures live output while preserving the exit code', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const promise = execInheritCapture('echo', ['hello']);
    child.stdout.emit('data', Buffer.from('hello\n'));
    child.stderr.emit('data', Buffer.from('warn\n'));
    child.emit('close', 5, null);

    await expect(promise).resolves.toEqual({
      stdout: 'hello\n',
      stderr: 'warn\n',
      exitCode: 5,
    });
    expect(stdoutWrite).toHaveBeenCalledWith('hello\n');
    expect(stderrWrite).toHaveBeenCalledWith('warn\n');
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });
});
