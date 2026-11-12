// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { git, gitBytes, gitResult, withPrivateIndex } from './index.js';
import { chunkPaths, nulFields } from './run.js';

const dir = useTempDir();

describe('git runner', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('ignores the operator configuration and inherited repository variables', async () => {
    const repo = join(dir(), 'repo');
    await initRepo(repo, { 'a.txt': 'a\n', 'für.txt': 'x\n' });
    await writeTree(repo, { 'a.txt': 'b\n', 'für.txt': 'y\n' });
    const home = join(dir(), 'home');
    await mkdir(home);
    await writeFile(
      join(home, '.gitconfig'),
      '[diff]\n\tnoprefix = true\n[core]\n\tquotePath = false\n[color]\n\tui = always\n'
    );
    process.env['HOME'] = home;
    process.env['GIT_CONFIG_GLOBAL'] = join(home, '.gitconfig');
    process.env['GIT_DIR'] = join(dir(), 'elsewhere');
    process.env['GIT_INDEX_FILE'] = join(dir(), 'elsewhere-index');
    const diff = await git(['diff'], { cwd: repo });
    expect(diff).toContain('diff --git a/a.txt b/a.txt');
    expect(diff).toContain('"a/f\\303\\274r.txt"');
    expect(diff).not.toContain('\u001b[');
  });

  it('never climbs from a directory that is not a repository into an enclosing one', async () => {
    const repo = dir();
    await initRepo(repo, { 'sub/a.txt': 'a\n' });
    await expect(git(['status'], { cwd: join(repo, 'sub') })).rejects.toMatchObject({
      code: 'git-not-a-repository',
      exitCode: 4,
    });
    await expect(git(['status'], { cwd: join(repo, 'missing') })).rejects.toMatchObject({
      code: 'git-not-a-repository',
    });
  });

  it('reports failures with a stable code and git stderr in message and cause', async () => {
    const repo = dir();
    await initRepo(repo);
    const failure = await git(['cat-file', '-p', 'no-such-ref'], { cwd: repo }).catch(
      (error: unknown) => error
    );
    expect(failure).toMatchObject({ code: 'git-failed', exitCode: 4 });
    expect((failure as Error).message).toContain('git cat-file -p no-such-ref');
    expect(((failure as Error).cause as Error).message).toContain('no-such-ref');
  });

  it('names a held index lock', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n' });
    await writeFile(join(repo, '.git', 'index.lock'), '');
    await writeTree(repo, { 'a.txt': 'b\n' });
    await expect(git(['add', 'a.txt'], { cwd: repo })).rejects.toMatchObject({
      code: 'git-index-locked',
    });
  });

  it('returns exit codes as results, stdout as bytes, and takes stdin and -c settings', async () => {
    const repo = dir();
    await initRepo(repo, { '.gitignore': 'ignored\n' });
    expect(
      (await gitResult(['merge-base', '--is-ancestor', 'HEAD', 'HEAD'], { cwd: repo })).exitCode
    ).toBe(0);
    const blob = (
      await git(['hash-object', '-w', '--stdin'], { cwd: repo, input: 'caf\xe9' })
    ).trim();
    expect(await gitBytes(['cat-file', 'blob', blob], { cwd: repo })).toEqual(
      Buffer.from('caf\xe9')
    );
    const value = await git(['config', '--get', 'fireforge.test'], {
      cwd: repo,
      config: { 'fireforge.test': 'yes' },
    });
    expect(value.trim()).toBe('yes');
  });

  it('runs plumbing in a private index without touching the repository index', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n' });
    const before = await readFile(join(repo, '.git', 'index'));
    const tree = await withPrivateIndex(repo, 'HEAD', async (index) => {
      await git(['rm', '--cached', '-q', 'a.txt'], { cwd: repo, index });
      return (await git(['write-tree'], { cwd: repo, index })).trim();
    });
    expect(tree).toBe((await git(['mktree'], { cwd: repo, input: '' })).trim());
    expect((await readFile(join(repo, '.git', 'index'))).equals(before)).toBe(true);
  });
});

describe('run helpers', () => {
  it('chunks paths under the byte budget without splitting or losing any', () => {
    const paths = Array.from({ length: 50 }, (_, index) => `dir/file-${index}.txt`);
    const chunks = chunkPaths(paths, 100);
    expect(chunks.flat()).toEqual(paths);
    expect(chunks.every((chunk) => chunk.join(' ').length <= 100)).toBe(true);
    expect(chunkPaths(['x'.repeat(500)], 100)).toEqual([['x'.repeat(500)]]);
  });

  it('splits -z output and refuses a path that is not UTF-8', () => {
    expect(nulFields(Buffer.from('a\0b c\0'))).toEqual(['a', 'b c']);
    expect(nulFields(Buffer.alloc(0))).toEqual([]);
    expect(() => nulFields(Buffer.from([0x66, 0xe9, 0]))).toThrow(
      expect.objectContaining({ code: 'git-path-encoding' })
    );
  });
});
