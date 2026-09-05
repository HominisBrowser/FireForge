// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

const { execMock, executableExistsMock, pathExistsMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  executableExistsMock: vi.fn(() => Promise.resolve(true)),
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  pathExistsMock: vi.fn((_path: string) => Promise.resolve(false)),
}));

vi.mock('../../utils/process.js', () => ({
  exec: execMock,
  executableExists: executableExistsMock,
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: pathExistsMock,
  readText: vi.fn(),
  removeFile: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

// readdir is used by stageAllFilesChunked, but not exercised in these tests
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, readdir: vi.fn(() => Promise.resolve([])), stat: vi.fn() };
});

import { GitIndexLockError, isGitIndexLockConflict } from '../../errors/git.js';
import { GitError } from '../../errors/git.js';
import { initRepository } from '../git.js';

function setupInitMocks(addResult: { exitCode: number; stdout: string; stderr: string }): void {
  execMock
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git init
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git checkout --orphan
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config email
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config name
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config core.preloadindex
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config core.untrackedCache
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config core.fsmonitor
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config feature.manyFiles
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config core.autocrlf
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git config core.eol
    .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // git remote add origin
    .mockResolvedValueOnce(addResult); // git add -A
}

describe('initRepository index-lock wrapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    executableExistsMock.mockResolvedValue(true);
    // Default: no lock file on disk
    pathExistsMock.mockResolvedValue(false);
  });

  it('wraps errors when stderr explicitly mentions index.lock with lock phrasing', async () => {
    setupInitMocks({
      exitCode: 128,
      stdout: '',
      stderr: "fatal: Unable to create '/project/engine/.git/index.lock': File exists.",
    });

    await expect(initRepository('/project/engine', 'firefox')).rejects.toBeInstanceOf(
      GitIndexLockError
    );
  });

  it('wraps errors when stderr contains lock-related keywords and lock file exists', async () => {
    setupInitMocks({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: unable to create new index file',
    });
    pathExistsMock.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('index.lock'))
    );

    await expect(initRepository('/project/engine', 'firefox')).rejects.toBeInstanceOf(
      GitIndexLockError
    );
  });

  it('does NOT wrap generic failures as lock errors even when lock file exists on disk', async () => {
    setupInitMocks({
      exitCode: 128,
      stdout: '',
      stderr: 'fatal: Out of memory, malloc failed',
    });
    pathExistsMock.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('index.lock'))
    );

    await expect(initRepository('/project/engine', 'firefox')).rejects.not.toBeInstanceOf(
      GitIndexLockError
    );
    await expect(initRepository('/project/engine', 'firefox')).rejects.toBeInstanceOf(GitError);
  });

  it('does NOT wrap when stderr is empty and lock file exists', async () => {
    setupInitMocks({ exitCode: 128, stdout: '', stderr: '' });
    pathExistsMock.mockImplementation((path: string) =>
      Promise.resolve(path.endsWith('index.lock'))
    );

    await expect(initRepository('/project/engine', 'firefox')).rejects.not.toBeInstanceOf(
      GitIndexLockError
    );
  });
});

describe('isGitIndexLockConflict', () => {
  it('recognises a GitIndexLockError instance', () => {
    expect(isGitIndexLockConflict(new GitIndexLockError('/x/.git/index.lock'))).toBe(true);
  });

  it('recognises the "Unable to create index.lock: File exists" message shape', () => {
    expect(
      isGitIndexLockConflict(
        new GitError("fatal: Unable to create '/x/.git/index.lock': File exists.", 'diff')
      )
    ).toBe(true);
  });

  it('recognises the "another git process seems to be running" message shape', () => {
    expect(
      isGitIndexLockConflict(
        new GitError(
          'index.lock is held: Another git process seems to be running in this repository',
          'add'
        )
      )
    ).toBe(true);
  });

  it('rejects git errors that merely mention index.lock without lock phrasing', () => {
    expect(isGitIndexLockConflict(new GitError('warning: index.lock cleaned up', 'gc'))).toBe(
      false
    );
  });

  it('rejects lock-phrased errors that do not mention index.lock', () => {
    expect(isGitIndexLockConflict(new GitError('fatal: config file exists', 'config'))).toBe(false);
  });

  it('rejects non-GitError values', () => {
    expect(isGitIndexLockConflict(new Error("Unable to create 'index.lock': File exists"))).toBe(
      false
    );
    expect(isGitIndexLockConflict('index.lock file exists')).toBe(false);
    expect(isGitIndexLockConflict(undefined)).toBe(false);
  });
});
