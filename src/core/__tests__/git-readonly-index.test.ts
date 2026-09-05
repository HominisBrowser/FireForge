// SPDX-License-Identifier: EUPL-1.2
/**
 * FireForge's read-only git plumbing must not write the primary checkout's
 * `.git/index`.
 *
 * These run against a REAL git repository on purpose. The defect is a
 * side effect of git itself (a `status`/`diff` stat-cache refresh rewrites
 * `.git/index`), so nothing short of observing the real index file proves
 * the fix.
 */
import { access, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, initCommittedRepo, removeTempProject } from '../../test-utils/index.js';
import { getAllDiff } from '../git-diff.js';
import {
  mintDisposableGitIndex,
  readOnlyGitIndexEnv,
  withPrivateGitIndex,
} from '../git-readonly-index.js';
import { getWorkingTreeStatus } from '../git-status.js';

/**
 * Forces git's next stat-cache comparison to differ, which is what makes
 * `status`/`diff` want to rewrite the index in the first place. Without
 * this the index would be untouched even without the fix and the test
 * would pass vacuously.
 */
async function invalidateStatCache(repoDir: string, file: string): Promise<void> {
  const path = join(repoDir, file);
  const future = new Date(Date.now() + 5_000);
  await utimes(path, future, future);
}

describe('withPrivateGitIndex', () => {
  let projectRoot: string;
  let repoDir: string;
  let indexPath: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('fireforge-roindex-');
    repoDir = join(projectRoot, 'engine');
    await initCommittedRepo(repoDir, {
      'browser/a.js': 'const a = 1;\n',
      'browser/b.js': 'const b = 2;\n',
    });
    indexPath = join(repoDir, '.git', 'index');
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('leaves the primary .git/index untouched across status and diff probes', async () => {
    await invalidateStatCache(repoDir, 'browser/a.js');
    await writeFile(join(repoDir, 'browser/b.js'), 'const b = 3;\n');
    const before = await stat(indexPath);

    await withPrivateGitIndex(repoDir, async () => {
      expect(readOnlyGitIndexEnv(repoDir)).toBeDefined();
      await getWorkingTreeStatus(repoDir);
      await getAllDiff(repoDir);
    });

    const after = await stat(indexPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('still reports the same working-tree facts through the private index', async () => {
    await writeFile(join(repoDir, 'browser/b.js'), 'const b = 3;\n');
    // `const b = 2;` -> `const b = 3;` is the SAME SIZE, written within the
    // same second as the index entry. Git's racy-clean heuristic can then
    // treat the file as unmodified without reading its content, so the scoped
    // and unscoped probes could disagree. The sibling test above already
    // invalidates for this reason.
    await invalidateStatCache(repoDir, 'browser/b.js');
    await writeFile(join(repoDir, 'browser/new.js'), 'const n = 1;\n');

    const scoped = await withPrivateGitIndex(repoDir, async () => ({
      status: await getWorkingTreeStatus(repoDir),
      diff: await getAllDiff(repoDir),
    }));
    const unscoped = {
      status: await getWorkingTreeStatus(repoDir),
      diff: await getAllDiff(repoDir),
    };

    expect(scoped.status.map((e) => e.file).sort()).toEqual(
      unscoped.status.map((e) => e.file).sort()
    );
    expect(scoped.diff).toBe(unscoped.diff);
  });

  it('tears the scope down after the operation, including on a throw', async () => {
    await expect(
      withPrivateGitIndex(repoDir, () => Promise.reject(new Error('boom')))
    ).rejects.toThrow('boom');
    expect(readOnlyGitIndexEnv(repoDir)).toBeUndefined();
  });

  it('fails open on a directory that is not a git checkout', async () => {
    const notARepo = join(projectRoot, 'not-a-repo');
    await createTempProject('unused-');
    await writeFile(join(projectRoot, 'plain.txt'), 'x\n');
    await expect(withPrivateGitIndex(notARepo, () => Promise.resolve('ran'))).resolves.toBe('ran');
    expect(readOnlyGitIndexEnv(notARepo)).toBeUndefined();
  });
});

describe('mintDisposableGitIndex', () => {
  let projectRoot: string;
  let repoDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-disposable-index-');
    repoDir = join(projectRoot, 'engine');
    await initCommittedRepo(repoDir, { 'a.txt': 'a\n' });
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('hands back an index overlay that is a real file, and disposes it', async () => {
    const minted = await mintDisposableGitIndex(repoDir);

    expect(minted).toBeDefined();
    const indexFile = minted?.env['GIT_INDEX_FILE'];
    expect(indexFile).toBeDefined();
    // Seeded from the repo's own index — an empty one would make a tracked,
    // unmodified file look like a fresh add.
    await expect(access(indexFile ?? '')).resolves.toBeUndefined();

    await minted?.dispose();
    await expect(access(indexFile ?? '')).rejects.toThrow();
  });

  it('gives each caller its own index, so two concurrent callers cannot collide', async () => {
    const [first, second] = await Promise.all([
      mintDisposableGitIndex(repoDir),
      mintDisposableGitIndex(repoDir),
    ]);

    expect(first?.env['GIT_INDEX_FILE']).not.toBe(second?.env['GIT_INDEX_FILE']);

    await first?.dispose();
    await second?.dispose();
  });

  it('returns undefined for a directory that is not a git checkout', async () => {
    // The caller's fallback depends on this being a value, not a throw.
    await expect(mintDisposableGitIndex(join(projectRoot, 'nowhere'))).resolves.toBeUndefined();
  });
});
