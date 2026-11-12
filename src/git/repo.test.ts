// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commitAll, git as testGit, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  cloneRepository,
  currentBranch,
  fetchCommit,
  getConfig,
  gitDir,
  initRepository,
  isAncestor,
  isRepository,
  listWorktrees,
  mergeBase,
  objectFormat,
  resolveRevision,
  setConfig,
  updateRef,
} from './index.js';

const dir = useTempDir();

describe('repositories', () => {
  it('creates bare and sha256 repositories with the requested branch', async () => {
    const bare = join(dir(), 'bare');
    await initRepository(bare, { bare: true, branch: 'trunk' });
    expect(await isRepository(bare)).toBe(true);
    expect(await currentBranch(bare)).toBe('trunk');
    const modern = join(dir(), 'modern');
    await initRepository(modern, { objectFormat: 'sha256' });
    expect(await objectFormat(modern)).toBe('sha256');
    expect(await objectFormat(bare)).toBe('sha1');
  });

  it('recognises a repository root only', async () => {
    const repo = dir();
    await initRepo(repo, { 'sub/a.txt': 'a\n' });
    expect(await isRepository(repo)).toBe(true);
    expect(await isRepository(join(repo, 'sub'))).toBe(false);
    expect(await isRepository(join(repo, 'missing'))).toBe(false);
    expect(await gitDir(repo)).toBe(join(repo, '.git'));
  });

  it('resolves revisions, peels them, and answers undefined for what does not exist', async () => {
    const repo = dir();
    const first = await initRepo(repo, { 'a.txt': 'a\n' });
    expect(await resolveRevision(repo, 'HEAD')).toBe(first);
    expect(await resolveRevision(repo, 'HEAD', 'tree')).toBe(
      (await testGit(repo, ['rev-parse', 'HEAD^{tree}'])).trim()
    );
    expect(await resolveRevision(repo, 'HEAD:a.txt')).toMatch(/^[0-9a-f]{40}$/);
    expect(await resolveRevision(repo, 'HEAD:missing.txt')).toBeUndefined();
    expect(await resolveRevision(repo, 'refs/heads/none')).toBeUndefined();
    const unborn = join(dir(), 'unborn');
    await initRepository(unborn);
    expect(await resolveRevision(unborn, 'HEAD')).toBeUndefined();
  });

  it('reads the branch, ancestry and merge base', async () => {
    const repo = dir();
    const base = await initRepo(repo, { 'a.txt': 'a\n' });
    expect(await currentBranch(repo)).toBe('main');
    await writeTree(repo, { 'a.txt': 'b\n' });
    const next = await commitAll(repo, 'next');
    await testGit(repo, ['checkout', '-q', '--orphan', 'other']);
    const orphan = await commitAll(repo, 'orphan');
    expect(await isAncestor(repo, base, next)).toBe(true);
    expect(await isAncestor(repo, next, base)).toBe(false);
    expect(await mergeBase(repo, base, next)).toBe(base);
    expect(await mergeBase(repo, next, orphan)).toBeUndefined();
    await testGit(repo, ['checkout', '-q', '--detach', base]);
    expect(await currentBranch(repo)).toBeUndefined();
  });

  it('reads, writes and removes repository configuration', async () => {
    const repo = dir();
    await initRepo(repo);
    expect(await getConfig(repo, 'merge.fireforge.driver')).toBeUndefined();
    await setConfig(repo, 'merge.fireforge.driver', 'fireforge merge %O %A %B');
    expect(await getConfig(repo, 'merge.fireforge.driver')).toBe('fireforge merge %O %A %B');
    await setConfig(repo, 'merge.fireforge.driver', undefined);
    await setConfig(repo, 'merge.fireforge.driver', undefined);
    expect(await getConfig(repo, 'merge.fireforge.driver')).toBeUndefined();
    // The repository file only: a pinned setting is not reported as the repository's.
    expect(await getConfig(repo, 'core.quotePath')).toBeUndefined();
  });

  it('lists worktrees with their branch and head', async () => {
    const repo = join(dir(), 'main');
    const head = await initRepo(repo, { 'a.txt': 'a\n' });
    const linked = join(dir(), 'linked');
    await testGit(repo, ['worktree', 'add', '-q', '--detach', linked]);
    const worktrees = await listWorktrees(repo);
    expect(worktrees).toEqual([
      { path: repo, head, branch: 'refs/heads/main', bare: false, locked: false, prunable: false },
      { path: linked, head, bare: false, locked: false, prunable: false },
    ]);
    expect(await gitDir(linked, { common: true })).toBe(join(repo, '.git'));
  });

  it('clones with shared objects and fetches one commit from another repository', async () => {
    const source = join(dir(), 'source');
    const head = await initRepo(source, { 'a.txt': 'a\n' });
    const clone = join(dir(), 'clone');
    await cloneRepository(source, clone, { shared: true });
    expect(await resolveRevision(clone, 'HEAD')).toBe(head);
    const target = join(dir(), 'target');
    await initRepository(target, { bare: true });
    await fetchCommit(target, source, head, { depth: 1 });
    await updateRef(target, 'refs/fireforge/pristine', head);
    expect(await resolveRevision(target, 'refs/fireforge/pristine', 'commit')).toBe(head);
  });
});
