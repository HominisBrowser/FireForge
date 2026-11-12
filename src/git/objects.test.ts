// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git as testGit, gitBytes as testGitBytes, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  captureWorktree,
  commitTree,
  emptyTree,
  initRepository,
  listTree,
  readBlobs,
  resolveRevision,
  setConfig,
  status,
  writeBlobs,
  writeTree as writeTreeObject,
} from './index.js';

const dir = useTempDir();
const BINARY = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x00, 0xff]);

async function show(repo: string, spec: string): Promise<Buffer> {
  return testGitBytes(repo, ['cat-file', 'blob', spec]);
}

describe('blobs', () => {
  it('reads many blobs exactly, by id or revision:path, skipping what is not a blob', async () => {
    const repo = dir();
    await initRepo(repo, { 'bin.dat': BINARY, 'dir/a b.txt': 'a\n', 'empty.txt': '' });
    const id = (await testGit(repo, ['rev-parse', 'HEAD:bin.dat'])).trim();
    const blobs = await readBlobs(repo, [
      id,
      'HEAD:dir/a b.txt',
      'HEAD:empty.txt',
      'HEAD:dir',
      'HEAD:missing',
    ]);
    expect(blobs.get(id)).toEqual(BINARY);
    expect(blobs.get('HEAD:dir/a b.txt')?.toString()).toBe('a\n');
    expect(blobs.get('HEAD:empty.txt')?.length).toBe(0);
    expect(blobs.has('HEAD:dir')).toBe(false);
    expect(blobs.has('HEAD:missing')).toBe(false);
    await expect(readBlobs(repo, ['a\nb'])).rejects.toMatchObject({ code: 'git-invalid-spec' });
  });

  it('stores bytes unconverted even where the repository would convert line endings', async () => {
    const repo = dir();
    await initRepo(repo);
    await writeTree(repo, { '.gitattributes': '* text eol=lf\n' });
    const [crlf, binary] = await writeBlobs(repo, [Buffer.from('a\r\nb\r\n'), BINARY]);
    expect(await show(repo, crlf ?? '')).toEqual(Buffer.from('a\r\nb\r\n'));
    expect(await show(repo, binary ?? '')).toEqual(BINARY);
    expect(await writeBlobs(repo, [])).toEqual([]);
  });
});

describe('trees', () => {
  it('lists a tree recursively or one level deep, scoped to paths', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n', 'dir/b.txt': 'b\n', 'dir/sub/c.txt': 'c\n' });
    expect((await listTree(repo, 'HEAD')).map((entry) => entry.path)).toEqual([
      'a.txt',
      'dir/b.txt',
      'dir/sub/c.txt',
    ]);
    expect(await listTree(repo, 'HEAD', { recursive: false })).toMatchObject([
      { path: 'a.txt', type: 'blob', mode: '100644' },
      { path: 'dir', type: 'tree', mode: '040000' },
    ]);
    expect(
      (await listTree(repo, 'HEAD', { paths: ['dir/sub'] })).map((entry) => entry.path)
    ).toEqual(['dir/sub/c.txt']);
  });

  it('writes a tree from a base and edits without touching the index', async () => {
    const repo = dir();
    await initRepo(repo, { 'keep.txt': 'keep\n', 'drop.txt': 'drop\n', 'swap.txt': 'old\n' });
    const index = await readFile(join(repo, '.git', 'index'));
    const reused = (await testGit(repo, ['rev-parse', 'HEAD:keep.txt'])).trim();
    const tree = await writeTreeObject(
      repo,
      [
        { path: 'drop.txt', remove: true },
        { path: 'swap.txt', content: Buffer.from('new\n') },
        { path: 'bin/run', content: Buffer.from('#!/bin/sh\n'), mode: '100755' },
        { path: 'copy.txt', oid: reused, mode: '100644' },
      ],
      'HEAD'
    );
    expect((await listTree(repo, tree)).map((entry) => `${entry.mode} ${entry.path}`)).toEqual([
      '100755 bin/run',
      '100644 copy.txt',
      '100644 keep.txt',
      '100644 swap.txt',
    ]);
    expect((await show(repo, `${tree}:swap.txt`)).toString()).toBe('new\n');
    expect((await readFile(join(repo, '.git', 'index'))).equals(index)).toBe(true);
    expect(await writeTreeObject(repo, [])).toBe(await emptyTree(repo));
  });

  it('captures the working tree, untracked and named ignored files included', async () => {
    const repo = dir();
    await initRepo(repo, {
      '.gitignore': '*.log\n',
      'a.txt': 'a\n',
      'gone.txt': 'g\n',
      'dir/x.txt': 'x\n',
    });
    await writeTree(repo, {
      'a.txt': 'A\n',
      'dir/new.txt': 'n\n',
      'debug.log': 'l\n',
      'other.log': 'o\n',
    });
    await rm(join(repo, 'gone.txt'));
    await symlink('a.txt', join(repo, 'link'));
    const statusBefore = await status(repo);
    const index = await readFile(join(repo, '.git', 'index'));

    const all = await captureWorktree(repo);
    expect((await listTree(repo, all)).map((entry) => entry.path)).toEqual([
      '.gitignore',
      'a.txt',
      'dir/new.txt',
      'dir/x.txt',
      'link',
    ]);
    expect((await listTree(repo, all)).find((entry) => entry.path === 'link')?.mode).toBe('120000');
    expect((await show(repo, `${all}:a.txt`)).toString()).toBe('A\n');

    const scoped = await captureWorktree(repo, { paths: ['dir', 'debug.log'] });
    expect((await listTree(repo, scoped)).map((entry) => entry.path)).toEqual([
      '.gitignore',
      'a.txt',
      'debug.log',
      'dir/new.txt',
      'dir/x.txt',
      'gone.txt',
    ]);
    expect((await show(repo, `${scoped}:a.txt`)).toString()).toBe('a\n');

    const everything = await captureWorktree(repo, { base: null, includeIgnored: true });
    expect((await listTree(repo, everything)).map((entry) => entry.path)).toContain('other.log');

    expect(await status(repo)).toEqual(statusBefore);
    expect((await readFile(join(repo, '.git', 'index'))).equals(index)).toBe(true);
  });

  it('captures an unborn repository from nothing', async () => {
    const repo = dir();
    await initRepository(repo);
    await writeTree(repo, { 'a.txt': 'a\n' });
    const tree = await captureWorktree(repo);
    expect((await listTree(repo, tree)).map((entry) => entry.path)).toEqual(['a.txt']);
  });
});

describe('commits', () => {
  it('gives the same commit id on any host for a fixed identity and date', async () => {
    const ids: string[] = [];
    for (const name of ['one', 'two']) {
      const repo = join(dir(), name);
      await initRepository(repo);
      await setConfig(repo, 'user.name', `Someone ${name}`);
      await writeTree(repo, { 'a.txt': 'a\n', 'b/c.txt': 'c\n' });
      const tree = await captureWorktree(repo, { base: null, includeIgnored: true });
      ids.push(
        await commitTree(repo, tree, { message: 'Firefox 140.0', date: '2000-01-01T00:00:00Z' })
      );
    }
    expect(ids[0]).toBe(ids[1]);
    const repo = join(dir(), 'one');
    const commit = ids[0] ?? '';
    expect((await testGit(repo, ['log', '-1', '--format=%an <%ae> %at %s', commit])).trim()).toBe(
      'FireForge <fireforge@localhost> 946684800 Firefox 140.0'
    );
    const child = await commitTree(repo, await emptyTree(repo), {
      message: 'child',
      parents: [commit],
      identity: { name: 'X', email: 'x@example.test' },
    });
    expect(await resolveRevision(repo, `${child}^`)).toBe(commit);
  });
});
