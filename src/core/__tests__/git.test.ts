// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitIndexLockError } from '../../errors/git.js';
import { runGit } from '../../test-utils/index.js';
import {
  hasChanges,
  initRepository,
  isMissingHeadError,
  resetChanges,
  resumeRepository,
  stageAllFiles,
} from '../git.js';
import { getFileContentAtRef } from '../git-file-ops.js';
import { getDirtyFiles, getWorkingTreeStatus, parsePorcelainStatus } from '../git-status.js';

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

  it('parses filenames containing spaces', () => {
    const output = 'M  path with spaces/file name.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.file).toBe('path with spaces/file name.ts');
  });

  it('parses a worktree-only deletion', () => {
    const output = ' D worktree-deleted.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ worktreeStatus: 'D', isDeleted: true });
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

  it('consumes the original path for a worktree-side rename (` R`)', () => {
    // git >= 2.18 with status.renames detects unstaged renames and puts the
    // R in the WORKTREE column. The old parser only consumed the second NUL
    // record for an index R, so `old.ts` became a bogus extra entry whose
    // status was its first two path characters.
    const output = ' R new.ts\0old.ts\0M  other.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      status: ' R',
      indexStatus: ' ',
      worktreeStatus: 'R',
      file: 'new.ts',
      originalPath: 'old.ts',
      isRenameOrCopy: true,
    });
    expect(entries[1]).toMatchObject({ file: 'other.ts', isRenameOrCopy: false });
  });

  it('consumes the original path for a staged rename with worktree edits (`RM`)', () => {
    const output = 'RM new.ts\0old.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: 'RM',
      file: 'new.ts',
      originalPath: 'old.ts',
      isRenameOrCopy: true,
    });
  });

  it('consumes the original path for a worktree-side copy (` C`)', () => {
    const output = ' C copy.ts\0original.ts\0?? scratch.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      status: ' C',
      file: 'copy.ts',
      originalPath: 'original.ts',
      isRenameOrCopy: true,
    });
    expect(entries[1]).toMatchObject({ file: 'scratch.ts', isUntracked: true });
  });

  it('does not treat a path starting with "R " as a rename', () => {
    // Only the two status columns decide; the path field is never inspected.
    const output = '?? R d.ts\0M  next.ts\0';
    const entries = parsePorcelainStatus(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ file: 'R d.ts', isRenameOrCopy: false });
    expect(entries[1]?.file).toBe('next.ts');
  });
});

describe('resetChanges', () => {
  it('removes tracked, staged, and untracked changes including staged additions', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-test-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'fireforge@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'FireForge Tests']);
      await writeFile(join(repoDir, 'tracked.txt'), 'original\n', 'utf8');
      await runGit(repoDir, ['add', 'tracked.txt']);
      await runGit(repoDir, ['commit', '-m', 'initial']);

      await writeFile(join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
      await writeFile(join(repoDir, 'staged-new.txt'), 'staged\n', 'utf8');
      await writeFile(join(repoDir, 'scratch.txt'), 'temp\n', 'utf8');
      await runGit(repoDir, ['add', 'staged-new.txt']);

      await resetChanges(repoDir);

      await expect(runGit(repoDir, ['status', '--short'])).resolves.toBe('');
      await expect(runGit(repoDir, ['diff', 'HEAD', '--name-only'])).resolves.toBe('');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('git status helpers', () => {
  it('throws when git status is requested outside a repository', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-status-error-'));

    try {
      await expect(getWorkingTreeStatus(repoDir)).rejects.toThrow(/git|repository/i);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('throws when dirty-file checks run outside a repository', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-dirty-error-'));

    try {
      await expect(getDirtyFiles(repoDir, ['file.txt'])).rejects.toThrow(/git|repository|head/i);
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
      await runGit(repoDir, ['init']);
      await writeFile(join(repoDir, '.git', 'index.lock'), '', 'utf8');

      await expect(initRepository(repoDir, 'firefox')).rejects.toBeInstanceOf(GitIndexLockError);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('materializes Firefox .hgignore before the initial baseline commit', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-ignorefile-'));

    try {
      await writeFile(join(repoDir, '.gitignore'), 'obj-*/\n*.pyc\n', 'utf8');
      await mkdir(join(repoDir, 'tools', 'lint'), { recursive: true });
      await writeFile(
        join(repoDir, 'tools', 'lint', 'ignorefile.yml'),
        'include:\n  - .hgignore\n'
      );

      await initRepository(repoDir, 'firefox');

      await expect(runGit(repoDir, ['show', 'HEAD:.hgignore'])).resolves.toBe('obj-*/\n*.pyc\n');
      await expect(runGit(repoDir, ['status', '--short'])).resolves.toBe('');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  // Git for Windows installs a global `core.autocrlf=true`. Patch bodies are
  // byte diffs of the working tree and `hashObjectBatch` delegates hashing to
  // git, so an engine checked out under that default hashes and exports
  // differently from the same tree everywhere else. The repository pins it.
  it('pins line endings on the repository so patch bytes do not depend on host git config', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-eol-'));

    try {
      await writeFile(join(repoDir, 'tracked.txt'), 'initial\n', 'utf8');

      await initRepository(repoDir, 'firefox');

      await expect(runGit(repoDir, ['config', '--local', 'core.autocrlf'])).resolves.toBe(
        'false\n'
      );
      await expect(runGit(repoDir, ['config', '--local', 'core.eol'])).resolves.toBe('lf\n');
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
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['checkout', '--orphan', 'main']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');

      const progress: string[] = [];
      await resumeRepository(repoDir, { onProgress: (m) => progress.push(m) });

      // Should have created the initial commit
      const log = await runGit(repoDir, ['log', '--oneline']);
      expect(log).toContain('Initial Firefox source');
      expect(progress.length).toBeGreaterThan(0);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('materializes Firefox .hgignore before committing a resumed baseline', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-resume-ignorefile-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['checkout', '--orphan', 'main']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, '.gitignore'), 'obj-*/\n*.pyc\n', 'utf8');
      await mkdir(join(repoDir, 'tools', 'lint'), { recursive: true });
      await writeFile(
        join(repoDir, 'tools', 'lint', 'ignorefile.yml'),
        'include:\n  - .hgignore\n'
      );

      await resumeRepository(repoDir);

      await expect(runGit(repoDir, ['show', 'HEAD:.hgignore'])).resolves.toBe('obj-*/\n*.pyc\n');
      await expect(runGit(repoDir, ['status', '--short'])).resolves.toBe('');
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
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'a.txt'), 'a\n', 'utf8');
      await writeFile(join(repoDir, 'b.txt'), 'b\n', 'utf8');

      await stageAllFiles(repoDir);

      const status = await runGit(repoDir, ['status', '--porcelain']);
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
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'initial.txt'), 'init\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'initial']);

      // Create a new file
      await writeFile(join(repoDir, 'new.txt'), 'new\n', 'utf8');

      await stageAllFiles(repoDir);
      await runGit(repoDir, ['commit', '-m', 'add new file']);

      const log = await runGit(repoDir, ['log', '--oneline']);
      expect(log).toContain('add new file');
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('getFileContentAtRef', () => {
  it('reads file content from an arbitrary commit, not just HEAD', async () => {
    // Regression guard for the furnace diff fix: when an override has been
    // applied to the working tree, reading from HEAD would return the
    // override content. Reading from the original baseCommit must still
    // return the pre-override content.
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-show-ref-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'widget.css'), '.root { color: blue; }\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'initial']);
      const baseCommit = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim();

      // Simulate an override applied to the engine worktree and committed.
      await writeFile(join(repoDir, 'widget.css'), '.root { color: red; }\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'override']);

      const pristine = await getFileContentAtRef(repoDir, 'widget.css', baseCommit);
      const head = await getFileContentAtRef(repoDir, 'widget.css');

      expect(pristine).toBe('.root { color: blue; }\n');
      expect(head).toBe('.root { color: red; }\n');
      // Backwards-compat wrapper still points at HEAD.
      expect(await getFileContentAtRef(repoDir, 'widget.css')).toBe(head);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns null for a file that does not exist at the requested ref', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-show-missing-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'existing.txt'), 'x\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'initial']);
      const baseCommit = (await runGit(repoDir, ['rev-parse', 'HEAD'])).trim();

      const content = await getFileContentAtRef(repoDir, 'not-there.txt', baseCommit);
      expect(content).toBeNull();
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});

describe('hasChanges', () => {
  it('returns false for a clean repo', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-changes-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'initial']);

      expect(await hasChanges(repoDir)).toBe(false);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });

  it('returns true when there are uncommitted changes', async () => {
    const repoDir = await mkdtemp(join(tmpdir(), 'fireforge-git-changes-'));

    try {
      await runGit(repoDir, ['init']);
      await runGit(repoDir, ['config', 'user.email', 'test@example.test']);
      await runGit(repoDir, ['config', 'user.name', 'Test']);
      await writeFile(join(repoDir, 'file.txt'), 'content\n', 'utf8');
      await runGit(repoDir, ['add', '.']);
      await runGit(repoDir, ['commit', '-m', 'initial']);

      await writeFile(join(repoDir, 'file.txt'), 'changed\n', 'utf8');

      expect(await hasChanges(repoDir)).toBe(true);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  });
});
