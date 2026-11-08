// SPDX-License-Identifier: EUPL-1.2
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createTempProject,
  initCommittedRepo,
  readProjectText,
  removeTempProject,
  runGit,
  setInteractiveMode,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { discardCommand } from '../discard.js';
import { resetCommand } from '../reset.js';

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  intro: vi.fn(),
  outro: vi.fn(),
  warn: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../utils/logger.js', () => logger);

describe('discardCommand and resetCommand integration', () => {
  let projectRoot: string;
  let restoreTTY: (() => void) | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    restoreTTY = setInteractiveMode(false);
    projectRoot = await createTempProject();
    await writeFireForgeConfig(projectRoot);
    await initCommittedRepo(join(projectRoot, 'engine'), {
      'tracked.txt': 'original\n',
      'rename-me.txt': 'rename source\n',
    });
  });

  afterEach(async () => {
    restoreTTY?.();
    await removeTempProject(projectRoot);
  });

  it('restores tracked modifications from HEAD', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
    });

    await discardCommand(projectRoot, 'tracked.txt', { yes: true });

    await expect(readProjectText(join(projectRoot, 'engine'), 'tracked.txt')).resolves.toBe(
      'original\n'
    );
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('deletes untracked files instead of running git restore', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'new.txt': 'untracked\n',
    });

    await discardCommand(projectRoot, 'new.txt', { yes: true });

    await expect(access(join(projectRoot, 'engine', 'new.txt'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('discards a file inside an untracked directory', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'nested/new.txt': 'untracked\n',
    });

    await discardCommand(projectRoot, 'nested/new.txt', { yes: true });

    await expect(access(join(projectRoot, 'engine', 'nested', 'new.txt'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('prunes the directories a discard empties, up to the first non-empty parent', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'keep/sibling.txt': 'tracked later\n',
      'keep/widget/inner/only.txt': 'untracked\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', 'keep/sibling.txt']);
    await runGit(join(projectRoot, 'engine'), ['commit', '-m', 'sibling']);

    await discardCommand(projectRoot, 'keep/widget/inner/only.txt', { yes: true });

    await expect(access(join(projectRoot, 'engine', 'keep', 'widget'))).rejects.toThrow();
    await expect(
      access(join(projectRoot, 'engine', 'keep', 'sibling.txt'))
    ).resolves.toBeUndefined();
    await expect(access(join(projectRoot, 'engine'))).resolves.toBeUndefined();
  });

  it('discards several paths in one call and prunes what they empty', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'gone-a/one.txt': '1\n',
      'gone-b/two.txt': '2\n',
    });

    await discardCommand(projectRoot, ['tracked.txt', 'gone-a/one.txt', 'gone-b/two.txt'], {
      yes: true,
    });

    await expect(readProjectText(join(projectRoot, 'engine'), 'tracked.txt')).resolves.toBe(
      'original\n'
    );
    await expect(access(join(projectRoot, 'engine', 'gone-a'))).rejects.toThrow();
    await expect(access(join(projectRoot, 'engine', 'gone-b'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('saves a recovery snapshot holding the discarded untracked file', async () => {
    await writeFiles(join(projectRoot, 'engine'), { 'precious.txt': 'only copy\n' });

    await discardCommand(projectRoot, 'precious.txt', { yes: true });

    const refs = (
      await runGit(join(projectRoot, 'engine'), [
        'for-each-ref',
        '--format=%(refname)',
        'refs/fireforge/recovery/',
      ])
    )
      .trim()
      .split('\n');
    expect(refs).toHaveLength(1);
    await expect(
      runGit(join(projectRoot, 'engine'), ['show', `${refs[0]}:precious.txt`])
    ).resolves.toBe('only copy\n');
    // The snapshot never touches the checkout's own index or branch.
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('saves a recovery snapshot of tracked edits and untracked files before reset', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'edited\n',
      'scratch.txt': 'temp\n',
    });

    await resetCommand(projectRoot, { yes: true });

    const ref = (
      await runGit(join(projectRoot, 'engine'), [
        'for-each-ref',
        '--format=%(refname)',
        'refs/fireforge/recovery/',
      ])
    ).trim();
    await expect(runGit(join(projectRoot, 'engine'), ['show', `${ref}:scratch.txt`])).resolves.toBe(
      'temp\n'
    );
    await expect(runGit(join(projectRoot, 'engine'), ['show', `${ref}:tracked.txt`])).resolves.toBe(
      'edited\n'
    );
  });

  it('handles staged renames using the original path', async () => {
    await runGit(join(projectRoot, 'engine'), ['mv', 'rename-me.txt', 'renamed.txt']);

    await discardCommand(projectRoot, 'rename-me.txt', { yes: true });

    await expect(access(join(projectRoot, 'engine', 'rename-me.txt'))).resolves.toBeUndefined();
    await expect(access(join(projectRoot, 'engine', 'renamed.txt'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('shows precise rename labels in reset dry-run output', async () => {
    await runGit(join(projectRoot, 'engine'), ['mv', 'rename-me.txt', 'renamed.txt']);
    await writeFiles(join(projectRoot, 'engine'), {
      'scratch.txt': 'temp\n',
    });

    await resetCommand(projectRoot, { dryRun: true });

    expect(logger.info).toHaveBeenCalledWith('Would reset 2 files:');
    expect(logger.info).toHaveBeenCalledWith('  rename-me.txt -> renamed.txt');
    expect(logger.info).toHaveBeenCalledWith('  scratch.txt');
  });

  it('expands untracked directories in reset dry-run output', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'nested/one.txt': 'one\n',
      'nested/two.txt': 'two\n',
    });

    await resetCommand(projectRoot, { dryRun: true });

    expect(logger.info).toHaveBeenCalledWith('Would reset 2 files:');
    expect(logger.info).toHaveBeenCalledWith('  nested/one.txt');
    expect(logger.info).toHaveBeenCalledWith('  nested/two.txt');
  });

  it('removes staged additions, tracked edits, and untracked files on reset', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'tracked.txt': 'changed\n',
      'staged-new.txt': 'staged\n',
      'scratch.txt': 'temp\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', 'staged-new.txt']);

    await resetCommand(projectRoot, { yes: true });

    await expect(readProjectText(join(projectRoot, 'engine'), 'tracked.txt')).resolves.toBe(
      'original\n'
    );
    await expect(access(join(projectRoot, 'engine', 'staged-new.txt'))).rejects.toThrow();
    await expect(access(join(projectRoot, 'engine', 'scratch.txt'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });

  it('discards staged added files cleanly', async () => {
    await writeFiles(join(projectRoot, 'engine'), {
      'staged-new.txt': 'staged\n',
    });
    await runGit(join(projectRoot, 'engine'), ['add', 'staged-new.txt']);

    await discardCommand(projectRoot, 'staged-new.txt', { yes: true });

    await expect(access(join(projectRoot, 'engine', 'staged-new.txt'))).rejects.toThrow();
    await expect(runGit(join(projectRoot, 'engine'), ['status', '--short'])).resolves.toBe('');
  });
});
