// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { exec, execInherit, execInheritCapture, execStream } from '../process.js';

class MockStream extends EventEmitter {}

interface MockChildProcess extends EventEmitter {
  stdout: MockStream;
  stderr: MockStream;
}

const { mockSpawn } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

function makeChild(): MockChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new MockStream(),
    stderr: new MockStream(),
  });
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
