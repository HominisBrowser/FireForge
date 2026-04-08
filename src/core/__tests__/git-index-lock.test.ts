// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../utils/logger.js', () => ({
  verbose: vi.fn(),
}));

// readdir is used by stageAllFilesChunked; not exercised in these tests
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, readdir: vi.fn(() => Promise.resolve([])), stat: vi.fn() };
});

import { GitIndexLockError } from '../../errors/git.js';
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
