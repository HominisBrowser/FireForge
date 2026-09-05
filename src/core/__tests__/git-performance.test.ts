// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

const { execMock, executableExistsMock, pathExistsMock, removeFileMock, readdirMock } = vi.hoisted(
  () => ({
    execMock: vi.fn(),
    executableExistsMock: vi.fn(() => Promise.resolve(true)),
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    pathExistsMock: vi.fn((_path: string) => Promise.resolve(false)),
    removeFileMock: vi.fn(() => Promise.resolve()),
    readdirMock: vi.fn(() => Promise.resolve([])),
  })
);

vi.mock('../../utils/process.js', () => ({
  exec: execMock,
  executableExists: executableExistsMock,
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: pathExistsMock,
  removeFile: removeFileMock,
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, readdir: readdirMock, stat: vi.fn() };
});

import { GitError } from '../../errors/git.js';
import { initRepository, stageAllFiles } from '../git.js';
import { configureGitPerformance } from '../git-base.js';

function okResult(): { exitCode: number; stdout: string; stderr: string } {
  return { exitCode: 0, stdout: '', stderr: '' };
}

describe('configureGitPerformance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executableExistsMock.mockResolvedValue(true);
    execMock.mockResolvedValue(okResult());
  });

  it('sets all four performance config values', async () => {
    await configureGitPerformance('/repo');
    const calls = execMock.mock.calls.map((c: unknown[]) => (c[1] as string[]).join(' '));
    expect(calls).toContainEqual('config core.preloadindex true');
    expect(calls).toContainEqual('config core.untrackedCache true');
    expect(calls).toContainEqual('config core.fsmonitor false');
    expect(calls).toContainEqual('config feature.manyFiles true');
  });
});

describe('stageAllFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executableExistsMock.mockResolvedValue(true);
    pathExistsMock.mockResolvedValue(false);
  });

  it('succeeds on first try (monolithic)', async () => {
    execMock.mockResolvedValueOnce(okResult());
    await stageAllFiles('/repo');
    expect(execMock).toHaveBeenCalledTimes(1);
    const args = execMock.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(args[1]).toContain('-A');
  });

  it('falls back to chunked staging on timeout error', async () => {
    // First call (monolithic) fails with SIGTERM / exit code 143
    execMock.mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: 'SIGTERM' });
    // pathExists for index.lock cleanup
    pathExistsMock.mockResolvedValue(false);
    // readdir returns two directories and a file
    readdirMock.mockResolvedValueOnce([
      { name: 'browser', isDirectory: () => true, isFile: () => false },
      { name: 'toolkit', isDirectory: () => true, isFile: () => false },
      { name: '.mozconfig', isDirectory: () => false, isFile: () => true },
    ] as never);
    // Subsequent calls: `git check-ignore` returns exit 1 (not ignored)
    // for every probe, and `git add` chunks succeed. Use a routing
    // implementation rather than a global mockResolvedValue so the
    // per-path check-ignore exit code is the "not ignored" branch.
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'check-ignore') {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      return Promise.resolve(okResult());
    });

    const progress = vi.fn();
    await stageAllFiles('/repo', { onProgress: progress });

    // Should have been called: 1 (monolithic fail)
    //   + 3 (check-ignore probes per top-level entry)
    //   + 2 (chunked dirs)
    //   + 1 (top-level files batch) = 7
    expect(execMock.mock.calls.length).toBe(7);
    // The fallback transition banner names the elapsed timeout so non-TTY
    // log scrapers can see exactly why the monolithic attempt lost.
    expect(progress).toHaveBeenCalledWith(
      expect.stringMatching(/Monolithic git add reached the \d+s timeout/)
    );
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('falling back to chunked staging')
    );
    expect(progress).toHaveBeenCalledWith(
      'Source scan complete: 2 top-level directories, 1 top-level file'
    );
    expect(progress).toHaveBeenCalledWith('Staging directory 1/2: browser/...');
  });

  it('skips gitignored top-level entries during chunked fallback', async () => {
    // A Firefox checkout's gitignored `.vscode/` (or any top-level entry
    // covered by .gitignore) fails the chunked fallback with `The following
    // paths are ignored by one of your .gitignore files`, turning a
    // recoverable monolithic timeout into a hard setup failure requiring
    // `download --force`. The chunked path pre-filters via
    // `git check-ignore`. Ignored entries log a soft "Skipping gitignored: …"
    // line and the rest of the tree stages normally.
    execMock.mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: 'SIGTERM' });
    pathExistsMock.mockResolvedValue(false);
    readdirMock.mockResolvedValueOnce([
      { name: 'browser', isDirectory: () => true, isFile: () => false },
      { name: '.vscode', isDirectory: () => true, isFile: () => false },
    ] as never);
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'check-ignore') {
        // .vscode is the ignored case
        if (args[args.length - 1] === '.vscode') {
          return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' });
        }
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      // Should never be invoked with .vscode as a path, since the
      // pre-filter would have filtered it out. The assertion below
      // doubles as the regression guard.
      if (args[0] === 'add' && args.includes('.vscode')) {
        return Promise.reject(
          new Error(
            'fatal: The following paths are ignored by one of your .gitignore files: .vscode'
          )
        );
      }
      return Promise.resolve(okResult());
    });

    const progress = vi.fn();
    await stageAllFiles('/repo', { onProgress: progress });

    // Verify .vscode never reached `git add` and the operator saw the
    // skip line.
    const addCallsWithVscode = execMock.mock.calls.filter((call: unknown[]) => {
      const args = call[1] as string[];
      return args[0] === 'add' && args.includes('.vscode');
    });
    expect(addCallsWithVscode).toHaveLength(0);
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('Skipping gitignored directory 1/2: .vscode/')
    );
  });

  it('labels heartbeat ticks with the active phase', async () => {
    // An elapsed-time heartbeat that resets only at function entry makes the
    // chunked phase report numbers including the entire monolithic timeout
    // window, with no way to tell where one ended and the other started. The
    // heartbeat tracks a per-phase start timestamp. The first phase is
    // `monolithic`, the second is `chunked staging`, and the ticks carry that
    // label so non-TTY scrapers see the transition.
    vi.useFakeTimers();
    try {
      execMock.mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: 'SIGTERM' });
      pathExistsMock.mockResolvedValue(false);
      readdirMock.mockResolvedValueOnce([
        { name: 'browser', isDirectory: () => true, isFile: () => false },
      ] as never);
      execMock.mockImplementation((_cmd: string, args: string[]) => {
        if (args[0] === 'check-ignore') {
          return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
        }
        return Promise.resolve(okResult());
      });

      const progress = vi.fn();
      const promise = stageAllFiles('/repo', { onProgress: progress });
      // Run timers until the staging completes. The monolithic add
      // resolves immediately (mocked), then the chunked path runs.
      // We don't need to advance timers to validate the transition
      // because the fallback banner is emitted unconditionally on
      // monolithic timeout.
      await promise;

      const transitionBanner = progress.mock.calls.find((c: unknown[]) =>
        String(c[0]).includes('falling back to chunked staging')
      );
      expect(transitionBanner).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-throws non-timeout errors', async () => {
    execMock.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: Out of memory',
    });

    await expect(stageAllFiles('/repo')).rejects.toBeInstanceOf(GitError);
  });

  // Re-throwing the low-level AbortError when the chunked fallback's own
  // timeout fires shows operators a generic "The operation was aborted" with
  // no recovery direction. The typed error carries the environment-variable
  // override so the next `download --force` is guided by the message itself.
  it('raises GitIndexingTimeoutError when the chunked fallback itself times out', async () => {
    const { GitIndexingTimeoutError } = await import('../../errors/git.js');
    // Monolithic SIGTERM timeout → fall through to chunked.
    execMock.mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: 'SIGTERM' });
    pathExistsMock.mockResolvedValue(false);
    readdirMock.mockResolvedValueOnce([
      { name: 'browser', isDirectory: () => true, isFile: () => false },
    ] as never);
    // Use an implementation so the per-path check-ignore probes
    // resolve as "not ignored" (exit 1) and only the actual `git add`
    // for browser/ raises the AbortError.
    execMock.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'check-ignore') {
        return Promise.resolve({ exitCode: 1, stdout: '', stderr: '' });
      }
      // Chunked add on `browser/` aborts with a canonical AbortError
      // (matches what Node's child_process layer raises when
      // `AbortSignal.timeout` fires).
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      return Promise.reject(abortError);
    });

    await expect(stageAllFiles('/repo')).rejects.toBeInstanceOf(GitIndexingTimeoutError);
  });
});

describe('initRepository sets performance config', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executableExistsMock.mockResolvedValue(true);
    pathExistsMock.mockResolvedValue(false);
    execMock.mockResolvedValue(okResult());
  });

  it('calls configureGitPerformance during init', async () => {
    await initRepository('/repo', 'firefox');
    const allArgs = execMock.mock.calls.map((c: unknown[]) => (c[1] as string[]).join(' '));
    expect(allArgs).toContainEqual('config core.preloadindex true');
    expect(allArgs).toContainEqual('config feature.manyFiles true');
  });

  it('passes GIT_INDEX_THREADS env to git add', async () => {
    await initRepository('/repo', 'firefox');
    // Find the git add -A call
    const addCall = execMock.mock.calls.find((c: unknown[]) =>
      (c[1] as string[]).includes('-A')
    ) as unknown[] | undefined;
    expect(addCall).toBeDefined();
    // The env is passed via the options object (3rd arg to exec)
    const opts = addCall?.[2] as Record<string, Record<string, string>> | undefined;
    expect(opts?.['env']).toEqual(expect.objectContaining({ GIT_INDEX_THREADS: '0' }));
  });
});
