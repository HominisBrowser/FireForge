// SPDX-License-Identifier: EUPL-1.2
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
  verbose: vi.fn(),
  warn: vi.fn(),
}));

import { verbose, warn } from '../logger.js';
import {
  exec,
  execInherit,
  execInheritCapture,
  execSmokeRun,
  execStream,
  findExecutable,
} from '../process.js';
import { sweepProcessGroup } from '../process-group.js';

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
    kill: vi.fn(),
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
      stdoutTruncated: false,
      stderrTruncated: false,
    });
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
    // 'ü' is 0xC3 0xBC — emit the two bytes in separate chunks, as a pipe
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

    await expect(promise).rejects.toMatchObject({
      name: 'ExecTimeoutError',
      command: 'sleep',
      timeoutMs: 5,
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

  it('sends SIGTERM to the process group when the deadline fires and reports timedOut=true', async () => {
    vi.useFakeTimers();
    // execSmokeRun picks its kill strategy from process.platform — pin the
    // POSIX branch so this test exercises the process-group kill even when
    // the suite runs on Windows (the taskkill test below owns that branch).
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

      vi.advanceTimersByTime(250);
      // Negative PID targets the whole process group — this is the critical
      // invariant: a bare child.kill would leave forked content processes alive.
      expect(killSpy).toHaveBeenCalledWith(-98765, 'SIGTERM');

      vi.advanceTimersByTime(100);
      expect(killSpy).toHaveBeenCalledWith(-98765, 'SIGKILL');

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

  it('kills the descendant tree via taskkill /T /F on Windows when the deadline fires', async () => {
    vi.useFakeTimers();
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const child = makeSmokeChild(4242);
      // First spawn call is the smoke child; subsequent calls are taskkill.
      mockSpawn.mockImplementation((command: string) =>
        command === 'taskkill' ? makeChild() : child
      );
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const promise = execSmokeRun('fake-mach', ['run'], {
        smokeTimeoutMs: 200,
        killGraceMs: 50,
      });

      vi.advanceTimersByTime(250);
      // No process group on Windows — the tree kill must go through taskkill,
      // otherwise firefox descendants of the python wrapper survive.
      expect(mockSpawn).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/T', '/F'], {
        stdio: 'ignore',
      });
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

describe('process-group reaping (0.37.0 item 9a)', () => {
  const ORPHAN_LINE =
    '4243 /usr/bin/python3 -c from multiprocessing.spawn import spawn_main; spawn_main(tracker_fd=6, pipe_handle=12)';

  let originalPlatform: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    vi.useRealTimers();
  });

  function makeGroupChild(pid = 4242): MockChildProcess & { pid: number } {
    return Object.assign(makeChild(), { pid });
  }

  /**
   * A LAZY fake pgrep child: the close emission is scheduled when spawn()
   * actually runs (mockImplementationOnce), not when the test builds the
   * queue — otherwise the event fires before exec attaches listeners.
   */
  function pgrepChild(lines: string | undefined): () => MockChildProcess {
    return () => {
      const child = makeChild();
      queueMicrotask(() => {
        if (lines !== undefined) child.stdout.emit('data', Buffer.from(lines));
        child.emit('close', lines !== undefined ? 0 : 1, null);
      });
      return child;
    };
  }

  describe('sweepProcessGroup', () => {
    it('reaps a stranded multiprocessing worker with a group SIGTERM (simulated startup death)', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      // First pgrep: the stranded spawn worker survives; after the group
      // SIGTERM + grace, the re-list comes back empty.
      mockSpawn
        .mockImplementationOnce(pgrepChild(`${ORPHAN_LINE}\n`))
        .mockImplementationOnce(pgrepChild(undefined));

      const { survivors } = await sweepProcessGroup(4242, 10);

      expect(survivors).toHaveLength(1);
      expect(survivors[0]?.pid).toBe(4243);
      expect(survivors[0]?.command).toContain('multiprocessing.spawn');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('multiprocessing worker — the known busy-spin orphan shape')
      );
      expect(verbose).toHaveBeenCalledWith(expect.stringContaining('reaped cleanly with SIGTERM'));
      killSpy.mockRestore();
    });

    it('escalates to a group SIGKILL when survivors outlive the grace window', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      mockSpawn
        .mockImplementationOnce(pgrepChild(`${ORPHAN_LINE}\n`))
        .mockImplementationOnce(pgrepChild(`${ORPHAN_LINE}\n`))
        .mockImplementationOnce(pgrepChild(`${ORPHAN_LINE}\n`));

      await sweepProcessGroup(4242, 10);

      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGKILL');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('still has survivors after SIGKILL')
      );
      killSpy.mockRestore();
    });

    it("keeps the grace timer ref'd so the parent cannot exit mid-sweep", async () => {
      // The sweep runs from a child 'close' handler after the signal
      // forwarder is disposed — an unref'd grace timer let Node exit
      // during the grace window and skip the SIGKILL escalation. Pin
      // that the awaited delay holds a ref on the event loop.
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      const captured: NodeJS.Timeout[] = [];
      const realSetTimeout = globalThis.setTimeout;
      const timeoutSpy = vi
        .spyOn(globalThis, 'setTimeout')
        .mockImplementation((fn: () => void, ms?: number) => {
          const timer = realSetTimeout(fn, ms);
          captured.push(timer);
          return timer;
        });
      mockSpawn
        .mockImplementationOnce(pgrepChild(`${ORPHAN_LINE}\n`))
        .mockImplementationOnce(pgrepChild(undefined));

      const sweep = sweepProcessGroup(4242, 25);
      await vi.waitFor(() => {
        expect(captured.length).toBeGreaterThan(0);
      });
      expect(captured[0]?.hasRef()).toBe(true);

      await sweep;
      timeoutSpy.mockRestore();
      killSpy.mockRestore();
    });

    it('costs a single pgrep and sends no signals on a healthy run', async () => {
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      mockSpawn.mockImplementationOnce(pgrepChild(undefined));

      const { survivors } = await sweepProcessGroup(4242);

      expect(survivors).toEqual([]);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(killSpy).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      killSpy.mockRestore();
    });

    it('is a no-op on win32', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      const { survivors } = await sweepProcessGroup(4242);
      expect(survivors).toEqual([]);
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });

  describe('execStream with processGroup', () => {
    it('spawns detached on POSIX and sweeps the group after close', async () => {
      const child = makeGroupChild();
      mockSpawn.mockReturnValueOnce(child).mockImplementationOnce(pgrepChild(undefined));

      const promise = execStream('fake-mach', ['test'], { processGroup: true });
      child.emit('close', 0, null);

      await expect(promise).resolves.toBe(0);
      expect(mockSpawn).toHaveBeenNthCalledWith(
        1,
        'fake-mach',
        ['test'],
        expect.objectContaining({ detached: true })
      );
      // The post-run sweep ran (the pgrep spawn).
      expect(mockSpawn).toHaveBeenCalledTimes(2);
      expect(mockSpawn).toHaveBeenNthCalledWith(
        2,
        'pgrep',
        ['-g', '4242', '-lf'],
        expect.anything()
      );
    });

    it('stays non-detached and never sweeps without the option (default unchanged)', async () => {
      const child = makeGroupChild();
      mockSpawn.mockReturnValueOnce(child);

      const promise = execStream('fake-mach', ['test']);
      child.emit('close', 0, null);

      await expect(promise).resolves.toBe(0);
      expect(mockSpawn).toHaveBeenCalledTimes(1);
      expect(mockSpawn).toHaveBeenCalledWith(
        'fake-mach',
        ['test'],
        expect.objectContaining({ detached: false })
      );
    });

    it('forwards parent signals to the whole group, not just the direct child', async () => {
      const child = makeGroupChild();
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
      mockSpawn.mockReturnValueOnce(child).mockImplementationOnce(pgrepChild(undefined));

      const promise = execStream('fake-mach', ['test'], { processGroup: true });
      process.emit('SIGTERM');
      // Group-targeted kill: negative PID, and NOT the bare child.kill path.
      expect(killSpy).toHaveBeenCalledWith(-4242, 'SIGTERM');
      expect(child.kill).not.toHaveBeenCalled();

      child.emit('close', null, 'SIGTERM');
      await promise;
      killSpy.mockRestore();
    });
  });
});
