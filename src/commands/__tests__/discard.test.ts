// SPDX-License-Identifier: EUPL-1.2
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeGitStatusEntry, makeProjectPaths } from '../../test-utils/index.js';

const loggerState = vi.hoisted(() => ({
  spinnerStop: vi.fn(),
  spinnerError: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  isGitRepository: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/git-file-ops.js', () => ({
  discardStatusEntry: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/git-status.js', () => ({
  getWorkingTreeStatus: vi.fn(() => Promise.resolve([])),
  expandUntrackedDirectoryEntries: vi.fn((_engine: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    stop: loggerState.spinnerStop,
    error: loggerState.spinnerError,
  })),
}));

import { confirm } from '@clack/prompts';

import { getProjectPaths } from '../../core/config.js';
import { isGitRepository } from '../../core/git.js';
import { discardStatusEntry } from '../../core/git-file-ops.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../../core/git-status.js';
import { GitError } from '../../errors/git.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, isCancel, outro, spinner } from '../../utils/logger.js';
import { discardCommand } from '../discard.js';

describe('discardCommand', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = undefined;
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    loggerState.spinnerStop.mockReset();
    loggerState.spinnerError.mockReset();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(expandUntrackedDirectoryEntries).mockImplementation((_engine, entries) =>
      Promise.resolve(entries)
    );
    vi.mocked(discardStatusEntry).mockResolvedValue();
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(isCancel).mockReturnValue(false);
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it('fails when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(discardCommand('/project', 'tracked.txt')).rejects.toThrow(
      'Firefox source not found'
    );
  });

  it('fails when the engine directory is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);

    await expect(discardCommand('/project', 'tracked.txt')).rejects.toThrow(
      'Engine directory is not a git repository'
    );
  });

  it('fails when the requested file has no changes to discard', async () => {
    await expect(discardCommand('/project', 'tracked.txt')).rejects.toThrow(
      'File "tracked.txt" has no changes to discard.'
    );
  });

  it('requires --force in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);

    await expect(discardCommand('/project', 'tracked.txt')).rejects.toThrow(
      'Interactive confirmation not available. Use --force flag to discard without confirmation.'
    );

    expect(discardStatusEntry).not.toHaveBeenCalled();
  });

  it('shows the precise rename target during dry-run mode', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      makeGitStatusEntry({
        file: 'renamed.txt',
        originalPath: 'rename-me.txt',
        isRenameOrCopy: true,
      }),
    ]);

    await expect(
      discardCommand('/project', 'rename-me.txt', { dryRun: true })
    ).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('Would discard changes to: rename-me.txt -> renamed.txt');
    expect(outro).toHaveBeenCalledWith('Dry run complete — no changes made');
    expect(discardStatusEntry).not.toHaveBeenCalled();
  });

  it('returns cleanly when the user cancels confirmation', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);
    vi.mocked(confirm).mockResolvedValue(false);

    await expect(discardCommand('/project', 'tracked.txt')).resolves.toBeUndefined();

    expect(outro).toHaveBeenCalledWith('Discard cancelled');
    expect(discardStatusEntry).not.toHaveBeenCalled();
  });

  it('rethrows GitError instances from discardStatusEntry unchanged', async () => {
    const expected = new GitError('already wrapped', 'restore --source HEAD --staged --worktree');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);
    vi.mocked(discardStatusEntry).mockRejectedValue(expected);

    await expect(discardCommand('/project', 'tracked.txt', { force: true })).rejects.toBe(expected);

    expect(loggerState.spinnerError).toHaveBeenCalledWith('Discard failed');
  });

  it('wraps tracked-file discard failures with the restore command context', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);
    vi.mocked(discardStatusEntry).mockRejectedValue(new Error('disk full'));

    await expect(discardCommand('/project', 'tracked.txt', { force: true })).rejects.toMatchObject({
      message: 'Failed to discard tracked.txt',
      command: 'restore --source HEAD --staged --worktree -- tracked.txt',
    });
  });

  it('wraps untracked-file discard failures with the remove command context', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      makeGitStatusEntry({
        file: 'new.txt',
        status: '??',
        indexStatus: '?',
        worktreeStatus: '?',
        isUntracked: true,
      }),
    ]);
    vi.mocked(discardStatusEntry).mockRejectedValue(new Error('permission denied'));

    await expect(discardCommand('/project', 'new.txt', { force: true })).rejects.toMatchObject({
      message: 'Failed to discard new.txt',
      command: 'rm new.txt',
    });
  });

  it('reports successful discards through the spinner and outro', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);

    await expect(
      discardCommand('/project', 'tracked.txt', { force: true })
    ).resolves.toBeUndefined();

    expect(spinner).toHaveBeenCalledWith('Discarding changes to tracked.txt...');
    expect(loggerState.spinnerStop).toHaveBeenCalledWith('Discarded changes to tracked.txt');
    expect(outro).toHaveBeenCalledWith('File restored to original state');
  });
});
