// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  verbose: vi.fn(),
  warn: vi.fn(),
}));

import { ExecTimeoutError } from '../../errors/base.js';
import { warn } from '../logger.js';
import {
  exec,
  execInherit,
  execInheritCapture,
  execSmokeRun,
  execStream,
  findExecutable,
  waitForActiveChildShutdown,
} from '../process.js';
import type { ProcessOwnership } from '../process-group.js';

// Fixture pids are made up, so ownership must never read the real process table.
vi.mock('../process-birth.js', () => ({
  groupMembers: vi.fn(() => []),
  isAliveIn: vi.fn(() => false),
  readProcessCommands: vi.fn(() => Promise.resolve(new Map())),
  signalIfAlive: vi.fn(() => false),
  snapshotProcesses: vi.fn(() => Promise.resolve(new Map())),
}));

class MockStream extends EventEmitter {
  destroy = vi.fn();
}

interface MockChildProcess extends EventEmitter {
  pid: number | undefined;
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

function makeChild(pid?: number): MockChildProcess {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout: new MockStream(),
    stderr: new MockStream(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
    unref: vi.fn(),
  });
  return child;
}

/** The environment handed to the most recent `spawn`, typed for assertions. */
function spawnEnvFromLastCall(): NodeJS.ProcessEnv {
  const options = mockSpawn.mock.calls[0]?.[2] as { env?: NodeJS.ProcessEnv } | undefined;
  return options?.env ?? {};
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
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('removes envUnset keys from the inherited environment', async () => {
    // `env` can only add or overwrite, and mozbuild's coding-agent check
    // reads CLAUDECODE only for its presence, so setting it empty would not
    // unset it. The delete has to actually delete.
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    process.env['FIREFORGE_TEST_MARKER'] = '1';

    try {
      const promise = exec('echo', ['hi'], { envUnset: ['FIREFORGE_TEST_MARKER'] });
      child.emit('close', 0);
      await promise;

      const spawnEnv = spawnEnvFromLastCall();
      expect('FIREFORGE_TEST_MARKER' in spawnEnv).toBe(false);
    } finally {
      delete process.env['FIREFORGE_TEST_MARKER'];
    }
  });

  it('applies envUnset AFTER env, so an explicit set is still removed', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hi'], {
      env: { FIREFORGE_TEST_MARKER: 'set-by-caller' },
      envUnset: ['FIREFORGE_TEST_MARKER'],
    });
    child.emit('close', 0);
    await promise;

    const spawnEnv = spawnEnvFromLastCall();
    expect('FIREFORGE_TEST_MARKER' in spawnEnv).toBe(false);
  });

  it('leaves the environment untouched when envUnset is absent', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    process.env['FIREFORGE_TEST_MARKER'] = '1';

    try {
      const promise = exec('echo', ['hi']);
      child.emit('close', 0);
      await promise;

      const spawnEnv = spawnEnvFromLastCall();
      expect(spawnEnv['FIREFORGE_TEST_MARKER']).toBe('1');
    } finally {
      delete process.env['FIREFORGE_TEST_MARKER'];
    }
  });

  it('truncates oversized stdout safely and reports it via stdoutTruncated', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hello']);
    child.stdout.emit('data', Buffer.from('a'.repeat(50 * 1024 * 1024 + 128)));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toContain('[truncated — output exceeded 50 MB]');
    expect(result.exitCode).toBe(0);
    // Safety-critical consumers (archive-listing preflight) key on this flag:
    // a silently truncated listing is indistinguishable from a complete one.
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(false);
  });

  it('reassembles multibyte UTF-8 characters split across chunk boundaries', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('echo', ['hello']);
    // 'ü' is 0xC3 0xBC, so emit the two bytes in separate chunks, as a pipe
    // boundary can do. Per-chunk Buffer.toString() produced two U+FFFD here.
    child.stdout.emit('data', Buffer.from([0x66, 0xc3]));
    child.stdout.emit('data', Buffer.from([0xbc, 0x72]));
    child.emit('close', 0);

    const result = await promise;
    expect(result.stdout).toBe('für');
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
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  });

  it('rejects with ExecTimeoutError when the timeout AbortSignal fires', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('sleep', ['60'], { timeout: 5 });
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    child.emit('error', abortError);
    child.emit('close', null, 'SIGKILL');

    await expect(promise).rejects.toMatchObject({
      name: 'ExecTimeoutError',
      command: 'sleep',
      timeoutMs: 5,
    });
  });

  it('carries the output captured before the timeout on the ExecTimeoutError', async () => {
    // A `git add -A` killed at its budget must reject with more than the
    // budget: the partial stdout/stderr already collected says what git was
    // doing when it died.
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = exec('git', ['add', '-A'], { timeout: 5 });
    child.stdout.emit('data', Buffer.from('progress 1\nprogress 2\n'));
    child.stderr.emit('data', Buffer.from('warning: slow disk\n'));
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    child.emit('error', abortError);
    child.emit('close', null, 'SIGKILL');

    const error = await promise.then(
      () => undefined,
      (rejection: unknown) => rejection
    );
    expect(error).toBeInstanceOf(ExecTimeoutError);
    const timeout = error as ExecTimeoutError;
    expect(timeout.stdout).toBe('progress 1\nprogress 2\n');
    expect(timeout.stderr).toBe('warning: slow disk\n');
    expect(timeout.outputTruncated).toBe(false);
    // The user-facing rendering shows the tail, so the timeout is diagnosable.
    expect(timeout.userMessage).toContain('Output before the timeout (stderr)');
    expect(timeout.userMessage).toContain('warning: slow disk');
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
    const child = makeChild(12345);
    mockSpawn.mockReturnValue(child);

    const promise = execInherit('long-running', [], { shutdownGraceMs: 50 });
    // Parent receives SIGINT. The helper should kill the child with SIGTERM,
    // not synchronously exit the Node process.
    process.emit('SIGINT');
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Cooperative child exits promptly on SIGTERM.
    child.emit('close', null, 'SIGTERM');
    await expect(promise).resolves.toBe(128 + 15);
  });

  it('escalates to SIGKILL after the grace window if the child does not exit', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild(12345);
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

  it('does not signal an unidentified failed spawn when the parent receives a signal', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const promise = execInherit('missing-executable', []);
    process.emit('SIGINT');
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('error', new Error('spawn missing-executable ENOENT'));
    child.emit('close', -2, null);
    await expect(promise).rejects.toThrow('ENOENT');
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
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(stdoutWrite).toHaveBeenCalledWith('hello\n');
    expect(stderrWrite).toHaveBeenCalledWith('warn\n');
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });
});

describe('execSmokeRun', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeSmokeChild(pid = 12345): MockChildProcess & { pid: number } {
    return Object.assign(makeChild(), { pid });
  }

  it('dispatches one callback per complete line and drops the trailing newline', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
      onStdoutLine: (line) => stdoutLines.push(line),
      onStderrLine: (line) => stderrLines.push(line),
    });

    // Two complete lines and a partial one that should queue until newline.
    child.stdout.emit('data', Buffer.from('JavaScript error: foo\nLaunching browser\npart'));
    child.stdout.emit('data', Buffer.from('ial rest\n'));
    child.stderr.emit('data', Buffer.from('console.error: AsyncShutdown\n'));
    child.emit('close', 0, null);

    const result = await promise;
    expect(stdoutLines).toEqual(['JavaScript error: foo', 'Launching browser', 'partial rest']);
    expect(stderrLines).toEqual(['console.error: AsyncShutdown']);
    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it('flushes a trailing partial line when the child closes without a newline', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutLines: string[] = [];

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
      onStdoutLine: (line) => stdoutLines.push(line),
    });
    child.stdout.emit('data', Buffer.from('no trailing newline here'));
    child.emit('close', 0, null);

    await promise;
    expect(stdoutLines).toEqual(['no trailing newline here']);
  });

  it('strips a CR before the LF so CRLF-terminated lines do not leak a \\r', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutLines: string[] = [];

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
      onStdoutLine: (line) => stdoutLines.push(line),
    });
    child.stdout.emit('data', Buffer.from('first\r\nsecond\r\n'));
    child.emit('close', 0, null);

    await promise;
    expect(stdoutLines).toEqual(['first', 'second']);
  });

  it('treats lone \\r repaints as line terminators instead of accumulating them', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutLines: string[] = [];

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
      onStdoutLine: (line) => stdoutLines.push(line),
    });
    // Progress-bar style output: repaint frames separated by bare \r and no
    // \n ever. Pre-fix these grew the partial-line buffer without bound and
    // never reached the line matchers.
    child.stdout.emit('data', Buffer.from('progress 10%\rprogress 50%\rprogress 100%'));
    child.emit('close', 0, null);

    await promise;
    expect(stdoutLines).toEqual(['progress 10%', 'progress 50%', 'progress 100%']);
  });

  it('holds back a trailing \\r that may be half of a chunk-split CRLF', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const stdoutLines: string[] = [];

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
      onStdoutLine: (line) => stdoutLines.push(line),
    });
    child.stdout.emit('data', Buffer.from('split line\r'));
    child.stdout.emit('data', Buffer.from('\nnext\n'));
    child.emit('close', 0, null);

    await promise;
    expect(stdoutLines).toEqual(['split line', 'next']);
  });

  it('signals the group at the smoke deadline and escalates only after the grace', async () => {
    vi.useFakeTimers();
    // execSmokeRun picks its kill strategy from process.platform, so pin the
    // POSIX branch so this test exercises the process-group kill even when
    // the suite runs on Windows.
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const child = makeSmokeChild(98765);
      mockSpawn.mockReturnValue(child);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const promise = execSmokeRun('fake-mach', ['run'], {
        smokeTimeoutMs: 200,
        killGraceMs: 50,
      });

      // A Node handle that has not seen the exit proves the group is this one:
      // an unreaped leader keeps its PID.
      vi.advanceTimersByTime(220);
      expect(killSpy).toHaveBeenCalledWith(-98765, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-98765, 'SIGKILL');

      vi.advanceTimersByTime(40);
      expect(killSpy).toHaveBeenCalledWith(-98765, 'SIGKILL');

      Object.defineProperty(child, 'signalCode', { value: 'SIGTERM', configurable: true });
      child.emit('close', null, 'SIGTERM');
      const result = await promise;
      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBe(143);

      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      vi.useRealTimers();
    }
  });

  it('signals the live direct Windows child without inventing post-exit group authority', async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const child = makeSmokeChild(4242);
      // First spawn call is the smoke child. Subsequent calls are taskkill.
      mockSpawn.mockImplementation((command: string) =>
        command === 'taskkill' ? makeChild() : child
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const promise = execSmokeRun('fake-mach', ['run'], {
        smokeTimeoutMs: 200,
        killGraceMs: 50,
      });

      vi.advanceTimersByTime(250);
      // No process group on Windows, so the tree kill must go through
      // taskkill, otherwise firefox descendants of the python wrapper survive.
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(killSpy).not.toHaveBeenCalled();
      // Direct-child kill still fires as the taskkill-unavailable fallback.
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');

      child.emit('close', null, 'SIGTERM');
      const result = await promise;
      expect(result.timedOut).toBe(true);

      killSpy.mockRestore();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
      vi.useRealTimers();
    }
  });

  it('does not report timedOut when the child exits on its own before the deadline', async () => {
    const child = makeSmokeChild();
    mockSpawn.mockReturnValue(child);

    const promise = execSmokeRun('fake-mach', ['run'], {
      smokeTimeoutMs: 60_000,
    });
    child.emit('close', 0, null);

    const result = await promise;
    expect(result.timedOut).toBe(false);
  });
});

describe('findExecutable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first non-empty CRLF-delimited path without a trailing carriage return', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const promise = findExecutable('tool');
    child.stdout.emit('data', Buffer.from('\r\n/usr/local/bin/tool\r\n/usr/bin/tool\r\n'));
    child.emit('close', 0);

    await expect(promise).resolves.toBe('/usr/local/bin/tool');
  });
});

describe('tracked process ownership integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('announces a token alongside the diagnostic group number and waits for caller teardown', async () => {
    const child = makeChild(777);
    mockSpawn.mockReturnValue(child);
    const onProcessGroup = vi.fn();
    let release: () => void = () => undefined;
    const postCloseSweep = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    let resolved = false;
    const promise = execStream('fixture', [], {
      processGroup: true,
      onProcessGroup,
      postCloseSweep,
    }).then((code) => {
      resolved = true;
      return code;
    });
    const [announced, ownership] = onProcessGroup.mock.calls[0] as [number, ProcessOwnership];
    expect(announced).toBe(777);
    expect(ownership.pid).toBe(777);
    child.emit('close', 0, null);
    await vi.waitFor(() => {
      expect(postCloseSweep).toHaveBeenCalledOnce();
    });
    expect(resolved).toBe(false);
    release();
    await expect(promise).resolves.toBe(0);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('keeps the exit code and warns when caller-owned cleanup fails', async () => {
    const child = makeChild(777);
    mockSpawn.mockReturnValue(child);
    const promise = execStream('fixture', [], {
      processGroup: true,
      postCloseSweep: () => Promise.reject(new Error('census unavailable')),
    });
    child.emit('close', 0, null);
    await expect(promise).resolves.toBe(0);
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('census unavailable'));
  });

  it('keeps abort and shutdown tracking live until the caller cleanup completes', async () => {
    const child = makeChild(777);
    mockSpawn.mockReturnValue(child);
    let release: () => void = () => undefined;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const postCloseSweep = vi.fn(() => cleanup);
    let rejected = false;
    const outcome = execStream('fixture', [], {
      timeout: 20,
      processGroup: true,
      postCloseSweep,
    }).catch((error: unknown) => {
      rejected = true;
      return error;
    });
    child.emit('error', Object.assign(new Error('aborted'), { name: 'AbortError' }));
    child.emit('close', null, 'SIGKILL');
    await vi.waitFor(() => {
      expect(postCloseSweep).toHaveBeenCalledOnce();
    });
    let shutdownComplete = false;
    const shutdown = waitForActiveChildShutdown(5000).then(() => {
      shutdownComplete = true;
    });
    await Promise.resolve();
    expect(shutdownComplete).toBe(false);
    expect(rejected).toBe(false);
    release();
    expect(await outcome).toBeInstanceOf(ExecTimeoutError);
    await shutdown;
    expect(shutdownComplete).toBe(true);
  });

  it('runs caller cleanup after failed spawn closure and retains the actual startup error', async () => {
    const child = makeChild();
    mockSpawn.mockReturnValue(child);
    const failure = new Error('spawn ENOENT');
    const postCloseSweep = vi.fn(() => Promise.resolve());
    const outcome = execStream('missing-command', [], { postCloseSweep }).catch(
      (error: unknown) => error
    );
    child.emit('error', failure);
    child.emit('close', -2, null);
    expect(await outcome).toBe(failure);
    expect(postCloseSweep).toHaveBeenCalledOnce();
  });
});
