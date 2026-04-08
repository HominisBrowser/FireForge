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
  hasChanges: vi.fn(() => Promise.resolve(true)),
  resetChanges: vi.fn(() => Promise.resolve()),
  isGitRepository: vi.fn(() => Promise.resolve(true)),
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
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: loggerState.spinnerStop,
    error: loggerState.spinnerError,
  })),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

import * as prompts from '@clack/prompts';

import { getProjectPaths } from '../../core/config.js';
import { hasChanges, isGitRepository, resetChanges } from '../../core/git.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../../core/git-status.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { cancel, info, isCancel, outro, spinner, warn } from '../../utils/logger.js';
import { resetCommand } from '../reset.js';

describe('resetCommand', () => {
  let restoreTTY: (() => void) | undefined;

  beforeEach(() => {
    restoreTTY = undefined;
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    loggerState.spinnerStop.mockReset();
    loggerState.spinnerError.mockReset();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(hasChanges).mockResolvedValue(true);
    vi.mocked(resetChanges).mockResolvedValue();
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(expandUntrackedDirectoryEntries).mockImplementation((_engine, entries) =>
      Promise.resolve(entries)
    );
    vi.mocked(prompts.confirm).mockResolvedValue(true);
    vi.mocked(isCancel).mockReturnValue(false);
  });

  afterEach(() => {
    restoreTTY?.();
  });

  it('fails when the engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(resetCommand('/project', {})).rejects.toThrow('Firefox source not found');
  });

  it('fails when the engine directory is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);

    await expect(resetCommand('/project', {})).rejects.toThrow(
      'Engine directory is not a git repository'
    );
  });

  it('returns early when the working tree is already clean', async () => {
    vi.mocked(hasChanges).mockResolvedValue(false);

    await expect(resetCommand('/project', {})).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('No changes to reset');
    expect(outro).toHaveBeenCalledWith('Working tree already clean');
    expect(resetChanges).not.toHaveBeenCalled();
  });

  it('lists each affected file during dry-run mode', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      makeGitStatusEntry({
        file: 'renamed.txt',
        originalPath: 'rename-me.txt',
        isRenameOrCopy: true,
      }),
      makeGitStatusEntry({
        file: 'scratch.txt',
        status: '??',
        indexStatus: '?',
        worktreeStatus: '?',
        isUntracked: true,
      }),
    ]);

    await expect(resetCommand('/project', { dryRun: true })).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('Would reset 2 files:');
    expect(info).toHaveBeenCalledWith('  rename-me.txt -> renamed.txt');
    expect(info).toHaveBeenCalledWith('  scratch.txt');
    expect(outro).toHaveBeenCalledWith('Dry run complete — no changes made');
    expect(resetChanges).not.toHaveBeenCalled();
  });

  it('requires --force in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);

    await expect(resetCommand('/project', {})).rejects.toThrow(
      'Interactive confirmation not available. Use --force flag to reset without confirmation.'
    );

    expect(resetChanges).not.toHaveBeenCalled();
  });

  it('returns cleanly when the user cancels the confirmation prompt', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(prompts.confirm).mockResolvedValue(false);

    await expect(resetCommand('/project', {})).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'This will discard all uncommitted changes in the engine directory, including staged additions and untracked files.'
    );
    expect(cancel).toHaveBeenCalledWith('Reset cancelled');
    expect(resetChanges).not.toHaveBeenCalled();
  });

  it('treats prompt cancellation as a normal exit', async () => {
    restoreTTY = setInteractiveMode(true);
    vi.mocked(isCancel).mockReturnValue(true);

    await expect(resetCommand('/project', {})).resolves.toBeUndefined();

    expect(cancel).toHaveBeenCalledWith('Reset cancelled');
    expect(resetChanges).not.toHaveBeenCalled();
  });

  it('reports successful resets through the spinner and outro', async () => {
    await expect(resetCommand('/project', { force: true })).resolves.toBeUndefined();

    expect(spinner).toHaveBeenCalledWith('Resetting changes...');
    expect(loggerState.spinnerStop).toHaveBeenCalledWith('Changes reset');
    expect(outro).toHaveBeenCalledWith('Working tree restored to clean state');
    expect(resetChanges).toHaveBeenCalledWith('/project/engine');
  });

  it('surfaces reset failures after marking the spinner as failed', async () => {
    const expected = new Error('index lock');
    vi.mocked(resetChanges).mockRejectedValue(expected);

    await expect(resetCommand('/project', { force: true })).rejects.toBe(expected);

    expect(loggerState.spinnerError).toHaveBeenCalledWith('Reset failed');
  });
});
