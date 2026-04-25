// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

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
    // Chunked adds succeed
    execMock.mockResolvedValue(okResult());

    const progress = vi.fn();
    await stageAllFiles('/repo', { onProgress: progress });

    // Should have been called: 1 (monolithic fail) + 2 (dirs) + 1 (top-level files) = 4
    expect(execMock.mock.calls.length).toBe(4);
    // 2026-04-24 eval Finding 10: the fallback transition banner now
    // names the elapsed timeout so non-TTY log scrapers can see exactly
    // why the monolithic attempt lost.
    expect(progress).toHaveBeenCalledWith(
      expect.stringMatching(/Monolithic git add reached the \d+s timeout/)
    );
    expect(progress).toHaveBeenCalledWith(
      expect.stringContaining('falling back to chunked staging')
    );
  });

  it('re-throws non-timeout errors', async () => {
    execMock.mockResolvedValueOnce({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: Out of memory',
    });

    await expect(stageAllFiles('/repo')).rejects.toBeInstanceOf(GitError);
  });

  // 2026-04-24 eval Finding 10: the chunked fallback used to re-throw
  // the low-level AbortError when its own timeout fired. Operators saw
  // a generic "The operation was aborted" with no recovery direction;
  // the typed error carries the environment-variable override so the
  // next `download --force` is guided by the error message itself.
  it('raises GitIndexingTimeoutError when the chunked fallback itself times out', async () => {
    const { GitIndexingTimeoutError } = await import('../../errors/git.js');
    // Monolithic SIGTERM timeout → fall through to chunked.
    execMock.mockResolvedValueOnce({ exitCode: 143, stdout: '', stderr: 'SIGTERM' });
    pathExistsMock.mockResolvedValue(false);
    readdirMock.mockResolvedValueOnce([
      { name: 'browser', isDirectory: () => true, isFile: () => false },
    ] as never);
    // Chunked add on `browser/` aborts with a canonical AbortError
    // (matches what Node's child_process layer raises when
    // `AbortSignal.timeout` fires).
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    execMock.mockRejectedValueOnce(abortError);

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
