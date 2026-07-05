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

vi.mock('../../core/furnace-config.js', () => ({
  collectFurnaceManagedPrefixes: vi.fn(() => Promise.resolve(new Set<string>())),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    stop: loggerState.spinnerStop,
    error: loggerState.spinnerError,
  })),
}));

import { confirm } from '@clack/prompts';

import { getProjectPaths } from '../../core/config.js';
import { collectFurnaceManagedPrefixes } from '../../core/furnace-config.js';
import { isGitRepository } from '../../core/git.js';
import { discardStatusEntry } from '../../core/git-file-ops.js';
import { expandUntrackedDirectoryEntries, getWorkingTreeStatus } from '../../core/git-status.js';
import { GitError } from '../../errors/git.js';
import { setInteractiveMode } from '../../test-utils/index.js';
import { pathExists } from '../../utils/fs.js';
import { info, isCancel, outro, spinner, warn } from '../../utils/logger.js';
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

  it('requires --yes in non-interactive mode', async () => {
    restoreTTY = setInteractiveMode(false);
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);

    await expect(discardCommand('/project', 'tracked.txt')).rejects.toThrow(
      'Interactive confirmation not available. Use --yes flag to discard without confirmation.'
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

    await expect(discardCommand('/project', 'tracked.txt', { yes: true })).rejects.toBe(expected);

    expect(loggerState.spinnerError).toHaveBeenCalledWith('Discard failed');
  });

  it('wraps tracked-file discard failures with the restore command context', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);
    vi.mocked(discardStatusEntry).mockRejectedValue(new Error('disk full'));

    await expect(discardCommand('/project', 'tracked.txt', { yes: true })).rejects.toMatchObject({
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

    await expect(discardCommand('/project', 'new.txt', { yes: true })).rejects.toMatchObject({
      message: 'Failed to discard new.txt',
      command: 'rm new.txt',
    });
  });

  it('reports successful discards through the spinner and outro', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);

    await expect(discardCommand('/project', 'tracked.txt', { yes: true })).resolves.toBeUndefined();

    expect(spinner).toHaveBeenCalledWith('Discarding changes to tracked.txt...');
    expect(loggerState.spinnerStop).toHaveBeenCalledWith('Discarded changes to tracked.txt');
    expect(outro).toHaveBeenCalledWith('File restored to original state');
  });

  it('warns when the discarded file is managed by Furnace', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      makeGitStatusEntry({ file: 'browser/components/widgets/moz-card/moz-card.css' }),
    ]);
    vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
      new Set(['browser/components/widgets/'])
    );

    await expect(
      discardCommand('/project', 'browser/components/widgets/moz-card/moz-card.css', {
        yes: true,
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'This file is managed by Furnace. Run "fireforge furnace apply" to restore it.'
    );
  });

  it('skips the Furnace warning silently when the furnace config cannot be read', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([makeGitStatusEntry()]);
    vi.mocked(collectFurnaceManagedPrefixes).mockRejectedValue(new Error('no furnace.json'));

    await expect(discardCommand('/project', 'tracked.txt', { yes: true })).resolves.toBeUndefined();

    expect(warn).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('File restored to original state');
  });

  describe('directory-recursion fallback', () => {
    const dirEntries = [
      makeGitStatusEntry({ file: 'stories/furnace/a.css' }),
      makeGitStatusEntry({
        file: 'stories/furnace/b.css',
        status: '??',
        indexStatus: '?',
        worktreeStatus: '?',
        isUntracked: true,
      }),
    ];

    beforeEach(() => {
      vi.mocked(getWorkingTreeStatus).mockResolvedValue(dirEntries);
    });

    it('discards every entry under the directory with --yes', async () => {
      await expect(
        discardCommand('/project', 'stories/furnace', { yes: true })
      ).resolves.toBeUndefined();

      expect(discardStatusEntry).toHaveBeenCalledTimes(2);
      expect(loggerState.spinnerStop).toHaveBeenCalledWith(
        'Discarded 2 of 2 file(s) under stories/furnace/'
      );
      expect(outro).toHaveBeenCalledWith('2 file(s) restored to original state');
    });

    it('accepts a trailing slash on the directory path without doubling slashes in messages', async () => {
      await expect(
        discardCommand('/project', 'stories/furnace/', { yes: true })
      ).resolves.toBeUndefined();

      expect(discardStatusEntry).toHaveBeenCalledTimes(2);
      // The input's trailing slash must be normalized once on entry: every
      // user-facing message appends `/` itself and previously rendered
      // "stories/furnace//".
      expect(loggerState.spinnerStop).toHaveBeenCalledWith(
        'Discarded 2 of 2 file(s) under stories/furnace/'
      );
    });

    it('normalizes repeated trailing slashes in dry-run output', async () => {
      await expect(
        discardCommand('/project', 'stories/furnace//', { dryRun: true })
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        'Would discard changes to 2 file(s) under stories/furnace/:'
      );
      expect(discardStatusEntry).not.toHaveBeenCalled();
    });

    it('does not sweep sibling directories sharing the prefix', async () => {
      vi.mocked(getWorkingTreeStatus).mockResolvedValue([
        makeGitStatusEntry({ file: 'stories/furnace2/other.css' }),
      ]);

      await expect(discardCommand('/project', 'stories/furnace', { yes: true })).rejects.toThrow(
        'has no changes to discard'
      );
      expect(discardStatusEntry).not.toHaveBeenCalled();
    });

    it('lists the entries without discarding in dry-run mode', async () => {
      await expect(
        discardCommand('/project', 'stories/furnace', { dryRun: true })
      ).resolves.toBeUndefined();

      expect(info).toHaveBeenCalledWith(
        'Would discard changes to 2 file(s) under stories/furnace/:'
      );
      expect(info).toHaveBeenCalledWith('  stories/furnace/a.css');
      expect(outro).toHaveBeenCalledWith('Dry run complete — no changes made');
      expect(discardStatusEntry).not.toHaveBeenCalled();
    });

    it('requires --yes in non-interactive mode', async () => {
      restoreTTY = setInteractiveMode(false);

      await expect(discardCommand('/project', 'stories/furnace')).rejects.toThrow(
        'Interactive confirmation not available'
      );
      expect(discardStatusEntry).not.toHaveBeenCalled();
    });

    it('returns cleanly when the user cancels the batch confirmation', async () => {
      restoreTTY = setInteractiveMode(true);
      vi.mocked(confirm).mockResolvedValue(false);

      await expect(discardCommand('/project', 'stories/furnace')).resolves.toBeUndefined();

      expect(outro).toHaveBeenCalledWith('Discard cancelled');
      expect(discardStatusEntry).not.toHaveBeenCalled();
    });

    it('reports per-file failures and throws without blocking the rest of the batch', async () => {
      vi.mocked(discardStatusEntry)
        .mockRejectedValueOnce(new Error('permission denied'))
        .mockResolvedValueOnce(undefined);

      await expect(discardCommand('/project', 'stories/furnace', { yes: true })).rejects.toThrow(
        'Failed to discard 1 file(s) under stories/furnace/'
      );

      expect(discardStatusEntry).toHaveBeenCalledTimes(2);
      expect(loggerState.spinnerStop).toHaveBeenCalledWith(
        'Discarded 1 of 2 file(s) under stories/furnace/ (1 failed)'
      );
      expect(warn).toHaveBeenCalledWith('  stories/furnace/a.css: permission denied');
    });

    it('warns when the directory is Furnace-managed', async () => {
      vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set(['stories/furnace/']));

      await expect(
        discardCommand('/project', 'stories/furnace', { yes: true })
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        'These paths are managed by Furnace. Run "fireforge furnace apply" to redeploy components if needed.'
      );
    });

    it('still detects a managed prefix below the directory when the input has a trailing slash', async () => {
      // Discarding a PARENT of a managed prefix with a trailing-slash input:
      // before normalization the comparison used "stories/furnace//", which
      // is a prefix of nothing and prefixed by nothing here, silently
      // dropping the warning.
      vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
        new Set(['stories/furnace/components/'])
      );

      await expect(
        discardCommand('/project', 'stories/furnace/', { yes: true })
      ).resolves.toBeUndefined();

      expect(warn).toHaveBeenCalledWith(
        'These paths are managed by Furnace. Run "fireforge furnace apply" to redeploy components if needed.'
      );
    });
  });
});
