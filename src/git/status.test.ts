// SPDX-License-Identifier: EUPL-1.2
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git as testGit, initRepo } from '../testing/git.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import {
  checkAttributes,
  checkIgnore,
  cleanPaths,
  isTracked,
  listFiles,
  reset,
  resolveRevision,
  restorePaths,
  status,
} from './index.js';

const dir = useTempDir();

async function changedRepo(): Promise<string> {
  const repo = dir();
  await initRepo(repo, {
    '.gitignore': '*.log\nobj/\n',
    'tracked.txt': 'one\n',
    'gone.txt': 'bye\n',
    'dir/keep.txt': 'keep\n',
  });
  await writeTree(repo, {
    'tracked.txt': 'two\n',
    'staged.txt': 'staged\n',
    'new dir/a b.txt': 'a\n',
    'new dir/für.txt': 'f\n',
    'debug.log': 'log\n',
    'obj/out.o': 'o\n',
  });
  await rm(join(repo, 'gone.txt'));
  await testGit(repo, ['add', 'staged.txt']);
  return repo;
}

describe('status', () => {
  it('lists tracked changes and every untracked file, with exact paths', async () => {
    const repo = await changedRepo();
    const entries = await status(repo);
    expect(entries.map((entry) => `${entry.index}${entry.worktree} ${entry.path}`).sort()).toEqual([
      ' D gone.txt',
      ' M tracked.txt',
      '?? new dir/a b.txt',
      '?? new dir/für.txt',
      'A  staged.txt',
    ]);
    expect((await status(repo, { untracked: false })).map((entry) => entry.path).sort()).toEqual([
      'gone.txt',
      'staged.txt',
      'tracked.txt',
    ]);
    expect((await status(repo, { paths: ['new dir'] })).map((entry) => entry.path).sort()).toEqual([
      'new dir/a b.txt',
      'new dir/für.txt',
    ]);
  });

  it('lists tracked, untracked and ignored files, scoped to paths', async () => {
    const repo = await changedRepo();
    expect(await listFiles(repo)).toEqual([
      '.gitignore',
      'dir/keep.txt',
      'gone.txt',
      'staged.txt',
      'tracked.txt',
    ]);
    expect(await listFiles(repo, { which: 'untracked' })).toEqual([
      'new dir/a b.txt',
      'new dir/für.txt',
    ]);
    expect(await listFiles(repo, { which: 'ignored' })).toEqual(['debug.log', 'obj/out.o']);
    expect(await listFiles(repo, { paths: ['dir'] })).toEqual(['dir/keep.txt']);
    // Pathspecs are literal: a glob character matches only itself.
    expect(await listFiles(repo, { paths: ['*.txt'] })).toEqual([]);
  });

  it('answers whether a path is tracked, ignored, and what attributes it has', async () => {
    const repo = await changedRepo();
    await writeTree(repo, { '.gitattributes': '*.txt text eol=lf\n' });
    expect(await isTracked(repo, 'tracked.txt')).toBe(true);
    expect(await isTracked(repo, 'dir')).toBe(false);
    expect(await isTracked(repo, 'new dir/a b.txt')).toBe(false);
    expect(await checkIgnore(repo, ['debug.log', 'obj/out.o', 'tracked.txt', 'new.txt'])).toEqual(
      new Set(['debug.log', 'obj/out.o'])
    );
    expect(await checkIgnore(repo, ['tracked.txt'])).toEqual(new Set());
    const attributes = await checkAttributes(repo, ['tracked.txt', 'debug.log'], ['text', 'eol']);
    expect(attributes.get('tracked.txt')).toEqual({ text: 'set', eol: 'lf' });
    expect(attributes.get('debug.log')).toEqual({ text: 'unspecified', eol: 'unspecified' });
  });
});

describe('putting paths back', () => {
  it('restores tracked paths and drops additions the source lacks, leaving untracked files', async () => {
    const repo = await changedRepo();
    await restorePaths(repo, ['tracked.txt', 'gone.txt', 'staged.txt', 'new dir', 'nowhere.txt']);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(join(repo, 'gone.txt'), 'utf8')).toBe('bye\n');
    await expect(access(join(repo, 'staged.txt'))).rejects.toThrow();
    expect((await status(repo)).map((entry) => entry.path).sort()).toEqual([
      'new dir/a b.txt',
      'new dir/für.txt',
    ]);
  });

  it('restores from another commit', async () => {
    const repo = dir();
    const first = await initRepo(repo, { 'a.txt': 'first\n' });
    await writeTree(repo, { 'a.txt': 'second\n' });
    await testGit(repo, ['commit', '-qam', 'second']);
    await restorePaths(repo, ['a.txt'], { source: first });
    expect(await readFile(join(repo, 'a.txt'), 'utf8')).toBe('first\n');
  });

  it('cleans untracked files under paths, ignored ones only when asked', async () => {
    const repo = await changedRepo();
    await cleanPaths(repo, { paths: ['new dir'] });
    expect(await listFiles(repo, { which: 'untracked' })).toEqual([]);
    expect(await listFiles(repo, { which: 'ignored' })).toEqual(['debug.log', 'obj/out.o']);
    await cleanPaths(repo, { ignored: true });
    expect(await listFiles(repo, { which: 'ignored' })).toEqual([]);
  });

  it('resets hard or only the index', async () => {
    const repo = await changedRepo();
    await reset(repo, 'HEAD', 'mixed');
    expect(await isTracked(repo, 'staged.txt')).toBe(false);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('two\n');
    await reset(repo);
    expect(await readFile(join(repo, 'tracked.txt'), 'utf8')).toBe('one\n');
    const tree = await readTree(repo);
    expect(tree['gone.txt']).toBe('bye\n');
    expect(await resolveRevision(repo, 'HEAD')).toBeDefined();
  });
});
