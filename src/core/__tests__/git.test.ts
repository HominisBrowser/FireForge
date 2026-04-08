// SPDX-License-Identifier: EUPL-1.2
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitIndexLockError } from '../../errors/git.js';
import { git } from '../../test-utils/index.js';
import {
  commit,
  hasChanges,
  initRepository,
  isMissingHeadError,
  resetChanges,
  resumeRepository,
  stageAllFiles,
} from '../git.js';
import { parsePorcelainStatus } from '../git-status.js';

describe('parsePorcelainStatus', () => {
  it('returns empty array for empty output', () => {
    expect(parsePorcelainStatus('')).toEqual([]);
  });

  it('parses a modified file', () => {
    const output = 'M  src/app.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'M ',
      indexStatus: 'M',
      worktreeStatus: ' ',
      file: 'src/app.ts',
      isUntracked: false,
      isRenameOrCopy: false,
      isDeleted: false,
    });
  });

  it('parses untracked files', () => {
    const output = '?? new-file.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      isUntracked: true,
      file: 'new-file.ts',
    });
  });

  it('parses deleted files', () => {
    const output = 'D  removed.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      isDeleted: true,
      file: 'removed.ts',
    });
  });

  it('parses renamed files with original path', () => {
    const output = 'R  new-name.ts\0old-name.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'R ',
      file: 'new-name.ts',
      originalPath: 'old-name.ts',
      isRenameOrCopy: true,
    });
  });

  it('parses mixed status entries', () => {
    const output = 'M  file1.ts\0?? untracked.ts\0D  deleted.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(3);
    expect(entries[0]?.file).toBe('file1.ts');
    expect(entries[1]?.file).toBe('untracked.ts');
    expect(entries[2]?.file).toBe('deleted.ts');
  });

  it('parses rename followed by other entries', () => {
    const output = 'R  new.ts\0old.ts\0M  other.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      file: 'new.ts',
      originalPath: 'old.ts',
      isRenameOrCopy: true,
    });
    expect(entries[1]).toMatchObject({
      file: 'other.ts',
      isRenameOrCopy: false,
    });
  });

  it('parses copy entries', () => {
    const output = 'C  copy.ts\0original.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      indexStatus: 'C',
      file: 'copy.ts',
      originalPath: 'original.ts',
      isRenameOrCopy: true,
    });
  });

  it('skips records that are too short', () => {
    const output = 'M  file.ts\0ab\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.file).toBe('file.ts');
  });
});

describe('resetChanges', () => {
  it('removes tracked, staged, and untracked changes including staged additions', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-test-'));

    try {
      await git(repoDir, ['init']);
      await git(repoDir, ['config', 'user.email', 'fireforge@example.test']);
      await git(repoDir, ['config', 'user.name', 'FireForge Tests']);
      await writeFile(join(repoDir, 'tracked.txt'), 'original\n', 'utf8');
      await git(repoDir, ['add', 'tracked.txt']);
      await git(repoDir, ['commit', '-m', 'initial']);

      await writeFile(join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
      await writeFile(join(repoDir, 'staged-new.txt'), 'staged\n', 'utf8');
      await writeFile(join(repoDir, 'scratch.txt'), 'temp\n', 'utf8');
      await git(repoDir, ['add', 'staged-new.txt']);

      await resetChanges(repoDir);

      await expect(git(repoDir, ['status', '--short'])).resolves.toBe('');
      await expect(git(repoDir, ['diff', 'HEAD', '--name-only'])).resolves.toBe('');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('initRepository', () => {
  it('fails fast with a targeted error when a stale index.lock is present', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-lock-test-'));

    try {
      await writeFile(join(repoDir, 'tracked.txt'), 'initial\n', 'utf8');
      await git(repoDir, ['init']);
      await writeFile(join(repoDir, '.git', 'index.lock'), '', 'utf8');

      await expect(initRepository(repoDir, 'firefox')).rejects.toBeInstanceOf(GitIndexLockError);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('resumeRepository', () => {
  it('stages and commits on a repo with an unborn HEAD', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-resume-'));

    try {
      // Set up a partially-initialized repo (init + orphan but no commit)
      await git(repoDir, ['init']);
      await git(repoDir, ['checkout', '--orphan', 'main']);
      await git(repoDir, ['config', 'user.email', 'test@example.test']);
      await git(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');

      const progress: string[] = [];
      await resumeRepository(repoDir, { onProgress: (m) => progress.push(m) });

      // Should have created the initial commit
      const log = await git(repoDir, ['log', '--oneline']);
      expect(log).toContain('Initial Firefox source');
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('throws when directory is not a git repository', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-resume-'));

    try {
      await expect(resumeRepository(repoDir)).rejects.toThrow('Not a git repository');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('stageAllFiles', () => {
  it('stages all files in the repository', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-stage-'));

    try {
      await git(repoDir, ['init']);
      await git(repoDir, ['config', 'user.email', 'test@example.test']);
      await git(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'a.txt'), 'a\n', 'utf8');
      await writeFile(join(repoDir, 'b.txt'), 'b\n', 'utf8');

      await stageAllFiles(repoDir);

      const status = await git(repoDir, ['status', '--porcelain']);
      expect(status).toContain('A  a.txt');
      expect(status).toContain('A  b.txt');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('isMissingHeadError', () => {
  it('returns true for ambiguous HEAD errors', () => {
    expect(isMissingHeadError(new Error("ambiguous argument 'HEAD'"))).toBe(true);
  });

  it('returns true for unknown revision errors', () => {
    expect(isMissingHeadError(new Error('unknown revision or path not in the working tree'))).toBe(
      true
    );
  });

  it('returns false for unrelated errors', () => {
    expect(isMissingHeadError(new Error('something else'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isMissingHeadError('string')).toBe(false);
    expect(isMissingHeadError(null)).toBe(false);
  });
});

describe('commit', () => {
  it('stages and commits all changes', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-commit-'));

    try {
      await git(repoDir, ['init']);
      await git(repoDir, ['config', 'user.email', 'test@example.test']);
      await git(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'initial.txt'), 'init\n', 'utf8');
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-m', 'initial']);

      // Create a new file
      await writeFile(join(repoDir, 'new.txt'), 'new\n', 'utf8');

      await commit(repoDir, 'add new file');

      const log = await git(repoDir, ['log', '--oneline']);
      expect(log).toContain('add new file');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('hasChanges', () => {
  it('returns false for a clean repo', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-changes-'));

    try {
      await git(repoDir, ['init']);
      await git(repoDir, ['config', 'user.email', 'test@example.test']);
      await git(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-m', 'initial']);

      expect(await hasChanges(repoDir)).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns true when there are uncommitted changes', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-changes-'));

    try {
      await git(repoDir, ['init']);
      await git(repoDir, ['config', 'user.email', 'test@example.test']);
      await git(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');
      await git(repoDir, ['add', '.']);
      await git(repoDir, ['commit', '-m', 'initial']);

      await writeFile(join(repoDir, 'file.txt'), 'changed\n', 'utf8');

      expect(await hasChanges(repoDir)).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
