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
import { stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, initCommittedRepo, removeTempProject } from '../../test-utils/index.js';
import { getAllDiff } from '../git-diff.js';
import { hasReadOnlyGitIndexScope, withPrivateGitIndex } from '../git-readonly-index.js';
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
      expect(hasReadOnlyGitIndexScope()).toBe(true);
      await getWorkingTreeStatus(repoDir);
      await getAllDiff(repoDir);
    });

    const after = await stat(indexPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  it('still reports the same working-tree facts through the private index', async () => {
    await writeFile(join(repoDir, 'browser/b.js'), 'const b = 3;\n');
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
    expect(hasReadOnlyGitIndexScope()).toBe(false);
  });

  it('fails open on a directory that is not a git checkout', async () => {
    const notARepo = join(projectRoot, 'not-a-repo');
    await createTempProject('unused-');
    await writeFile(join(projectRoot, 'plain.txt'), 'x\n');
    await expect(withPrivateGitIndex(notARepo, () => Promise.resolve('ran'))).resolves.toBe('ran');
    expect(hasReadOnlyGitIndexScope()).toBe(false);
  });
});
