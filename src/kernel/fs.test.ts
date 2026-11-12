// SPDX-License-Identifier: EUPL-1.2
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  utimes,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import {
  appendText,
  cloneTree,
  copyFile,
  exists,
  freeDiskSpace,
  isInside,
  listDir,
  move,
  pathInfo,
  readBytesIfExists,
  readLink,
  readText,
  readTextIfExists,
  remove,
  resolveContained,
  resolveInside,
  TEMP_PATH_PATTERN,
  tempPathFor,
  toPosixPath,
  walkFiles,
  writeFile,
  writeFileFromStream,
  writeFileIfChanged,
  writeLink,
} from './fs.js';
import { hash, hashFile, randomId } from './hash.js';

const dir = useTempDir();

describe('reading', () => {
  it('describes a path without following a symlink, and reports absence as undefined', async () => {
    await writeTree(dir(), { 'a.txt': 'hello' });
    await symlink(join(dir(), 'missing'), join(dir(), 'dangling'));
    expect(await pathInfo(join(dir(), 'a.txt'))).toMatchObject({ kind: 'file', size: 5 });
    expect((await pathInfo(dir()))?.kind).toBe('directory');
    expect((await pathInfo(join(dir(), 'dangling')))?.kind).toBe('symlink');
    expect(await pathInfo(join(dir(), 'nope'))).toBeUndefined();
    expect(await pathInfo(join(dir(), 'a.txt', 'below-a-file'))).toBeUndefined();
    expect(await exists(join(dir(), 'dangling'))).toBe(true);
    expect(await exists(join(dir(), 'nope'))).toBe(false);
  });

  it('returns undefined for a missing file and throws for any other failure', async () => {
    expect(await readTextIfExists(join(dir(), 'nope'))).toBeUndefined();
    expect(await readBytesIfExists(join(dir(), 'nope'))).toBeUndefined();
    await expect(readTextIfExists(dir())).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('writeFile', () => {
  it('creates parent directories and leaves no temp file behind', async () => {
    const target = join(dir(), 'a/b/c.txt');
    await writeFile(target, 'content');
    expect(await readText(target)).toBe('content');
    expect(await readdir(join(dir(), 'a/b'))).toEqual(['c.txt']);
  });

  // Windows has no POSIX permission bits.
  it.skipIf(process.platform === 'win32')(
    "keeps the replaced file's mode unless one is given",
    async () => {
      const target = join(dir(), 'run.sh');
      await writeFile(target, '#!/bin/sh\n', { mode: 0o755 });
      await writeFile(target, '#!/bin/sh\necho\n');
      expect((await stat(target)).mode & 0o777).toBe(0o755);
      await writeFile(target, 'x', { mode: 0o600 });
      expect((await stat(target)).mode & 0o777).toBe(0o600);
    }
  );

  it('replaces a symlink instead of writing through it', async () => {
    await writeTree(dir(), { 'real.txt': 'original' });
    await symlink(join(dir(), 'real.txt'), join(dir(), 'link.txt'));
    await writeFile(join(dir(), 'link.txt'), 'new');
    expect(await readText(join(dir(), 'real.txt'))).toBe('original');
    expect((await lstat(join(dir(), 'link.txt'))).isSymbolicLink()).toBe(false);
  });

  it('does not truncate the other name of a hard link', async () => {
    await writeTree(dir(), { 'one.txt': 'shared' });
    await link(join(dir(), 'one.txt'), join(dir(), 'two.txt'));
    await writeFile(join(dir(), 'one.txt'), 'changed');
    expect(await readText(join(dir(), 'two.txt'))).toBe('shared');
  });

  it('writes only when the content differs', async () => {
    const target = join(dir(), 'out.txt');
    expect(await writeFileIfChanged(target, 'one')).toBe(true);
    const old = new Date(Date.now() - 60_000);
    await utimes(target, old, old);
    expect(await writeFileIfChanged(target, 'one')).toBe(false);
    expect((await stat(target)).mtimeMs).toBeLessThan(Date.now() - 30_000);
    expect(await writeFileIfChanged(target, Buffer.from('two'))).toBe(true);
    expect(await readText(target)).toBe('two');
  });

  it('publishes a stream only once it ended, and nothing when it failed', async () => {
    const target = join(dir(), 'archive.bin');
    async function* good(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('ab');
      await Promise.resolve();
      yield Buffer.from('cd');
    }
    expect(await writeFileFromStream(target, good())).toBe(4);
    expect(await readText(target)).toBe('abcd');
    async function* bad(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('partial');
      await Promise.resolve();
      throw new Error('connection reset');
    }
    await expect(writeFileFromStream(join(dir(), 'broken.bin'), bad())).rejects.toThrow(
      'connection reset'
    );
    expect(await readdir(dir())).toEqual(['archive.bin']);
  });

  it('appends, creating the file and its directory', async () => {
    const target = join(dir(), 'logs/history.jsonl');
    await appendText(target, 'a\n');
    await appendText(target, 'b\n');
    expect(await readText(target)).toBe('a\nb\n');
  });
});

describe('temp paths', () => {
  it('stages beside the target with a name the pattern recognises', () => {
    const temp = toPosixPath(tempPathFor('/project/patches/001-a.patch'));
    expect(temp.startsWith('/project/patches/.001-a.patch.fireforge-tmp-')).toBe(true);
    expect(TEMP_PATH_PATTERN.test(temp)).toBe(true);
    expect(TEMP_PATH_PATTERN.test('patches/.notes.fireforge-tmp-backup')).toBe(false);
    expect(toPosixPath(tempPathFor('/root-file'))).toMatch(/^\/\.root-file\.fireforge-tmp-/);
  });
});

describe('directories', () => {
  it('lists sorted entries with their kind, and a missing directory as empty', async () => {
    await writeTree(dir(), { 'b.txt': '', 'a/x.txt': '' });
    await symlink('b.txt', join(dir(), 'c'));
    expect(await listDir(dir())).toEqual([
      { name: 'a', kind: 'directory' },
      { name: 'b.txt', kind: 'file' },
      { name: 'c', kind: 'symlink' },
    ]);
    expect(await listDir(join(dir(), 'nope'))).toEqual([]);
  });

  it('walks files as sorted relative paths without following symlinks', async () => {
    await writeTree(dir(), { 'src/a.js': '', 'src/deep/b.js': '', 'obj/out.o': '', 'top.txt': '' });
    await symlink(dir(), join(dir(), 'src/loop'));
    expect(await walkFiles(dir())).toEqual([
      'obj/out.o',
      'src/a.js',
      'src/deep/b.js',
      'src/loop',
      'top.txt',
    ]);
    expect(await walkFiles(dir(), (path, kind) => path === 'obj' || kind === 'symlink')).toEqual([
      'src/a.js',
      'src/deep/b.js',
      'top.txt',
    ]);
    expect(await walkFiles(join(dir(), 'nope'))).toEqual([]);
  });

  it('removes trees and files, and treats absence as done', async () => {
    await writeTree(dir(), { 'a/b/c.txt': 'x', 'd.txt': 'y' });
    await remove(join(dir(), 'a'));
    await remove(join(dir(), 'd.txt'));
    await remove(join(dir(), 'never-existed'));
    expect(await readdir(dir())).toEqual([]);
  });

  it('moves a path over an existing one', async () => {
    await writeTree(dir(), { 'from.txt': 'new', 'to.txt': 'old' });
    await move(join(dir(), 'from.txt'), join(dir(), 'to.txt'));
    expect(await readTree(dir())).toEqual({ 'to.txt': 'new' });
  });
});

describe('copying', () => {
  // Windows has no POSIX permission bits.
  it.skipIf(process.platform === 'win32')('copies a file with its mode', async () => {
    await writeTree(dir(), { 'tool.sh': '#!/bin/sh\n' });
    await chmod(join(dir(), 'tool.sh'), 0o755);
    await copyFile(join(dir(), 'tool.sh'), join(dir(), 'out/tool.sh'));
    expect((await stat(join(dir(), 'out/tool.sh'))).mode & 0o777).toBe(0o755);
  });

  it('copies with the permission bits asked for', async () => {
    await writeTree(dir(), { 'tool.sh': '#!/bin/sh\n' });
    await copyFile(join(dir(), 'tool.sh'), join(dir(), 'out/tool.sh'), { mode: 0o700 });
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir(), 'out/tool.sh'))).mode & 0o777).toBe(0o700);
    }
    expect(await readFile(join(dir(), 'out/tool.sh'), 'utf8')).toBe('#!/bin/sh\n');
  });

  it('clones a tree with symlinks and modes intact, falling back to a copy when allowed', async () => {
    await writeTree(dir(), { 'src/a.txt': 'a', 'src/bin/run': '#!/bin/sh\n' });
    await chmod(join(dir(), 'src/bin/run'), 0o755);
    await symlink('a.txt', join(dir(), 'src/alias'));
    const how = await cloneTree(join(dir(), 'src'), join(dir(), 'clone'), { allowCopy: true });
    expect(['clone', 'copy']).toContain(how);
    expect(await readFile(join(dir(), 'clone/a.txt'), 'utf8')).toBe('a');
    expect((await lstat(join(dir(), 'clone/alias'))).isSymbolicLink()).toBe(true);
    // Windows has no POSIX permission bits.
    if (process.platform !== 'win32') {
      expect((await stat(join(dir(), 'clone/bin/run'))).mode & 0o777).toBe(0o755);
    }
    await writeFile(join(dir(), 'clone/a.txt'), 'changed');
    expect(await readText(join(dir(), 'src/a.txt'))).toBe('a');
  });

  it('reads a symlink as stored and replaces one in place', async () => {
    await writeTree(dir(), { 'a.txt': 'a', 'b.txt': 'b' });
    await writeLink(join(dir(), 'links/alias'), '../a.txt');
    // Windows stores a link's target with its own separators.
    expect(toPosixPath(await readLink(join(dir(), 'links/alias')))).toBe('../a.txt');
    await writeLink(join(dir(), 'links/alias'), join(dir(), 'b.txt'));
    expect(await readLink(join(dir(), 'links/alias'))).toBe(join(dir(), 'b.txt'));
    expect(await readText(join(dir(), 'links/alias'))).toBe('b');
    expect((await listDir(join(dir(), 'links'))).map((entry) => entry.name)).toEqual(['alias']);
  });

  it('refuses to clone onto an existing path', async () => {
    await mkdir(join(dir(), 'src'));
    await mkdir(join(dir(), 'taken'));
    await expect(cloneTree(join(dir(), 'src'), join(dir(), 'taken'))).rejects.toMatchObject({
      code: 'clone-target-exists',
    });
  });
});

describe('containment', () => {
  it.each([
    ['browser/a.js', true],
    ['', true],
    ['./a/../b', true],
    ['../outside', false],
    ['a/../../outside', false],
    ['/etc/passwd', false],
    ['/root/project/inside', true],
    ['/root/project-sibling/x', false],
    ['a\0b', false],
  ])('isInside(%j) is %s', (candidate, expected) => {
    expect(isInside('/root/project', candidate)).toBe(expected);
  });

  it('resolves a contained path and refuses an escape as an invalid argument', () => {
    expect(resolveInside('/root/project', 'a/./b')).toBe(resolve('/root/project/a/b'));
    expect(() => resolveInside('/root/project', '../x')).toThrow(
      expect.objectContaining({ code: 'path-escape', exitCode: 8 }) as Error
    );
  });

  it('refuses a path that passes through a symlink, wherever the link points', async () => {
    await writeTree(dir(), { 'project/real/a.txt': 'a', 'elsewhere/b.txt': 'b' });
    const root = join(dir(), 'project');
    await symlink(join(dir(), 'elsewhere'), join(root, 'out'));
    await symlink('real', join(root, 'alias'));
    await symlink('a.txt', join(root, 'real/leaf'));
    expect(await resolveContained(root, 'real/a.txt')).toBe(join(root, 'real/a.txt'));
    expect(await resolveContained(root, 'real/new/file.txt')).toBe(join(root, 'real/new/file.txt'));
    await expect(resolveContained(root, 'out/b.txt')).rejects.toMatchObject({
      code: 'path-escape',
    });
    await expect(resolveContained(root, 'alias/a.txt')).rejects.toMatchObject({
      code: 'path-escape',
    });
    await expect(resolveContained(root, 'real/leaf')).rejects.toMatchObject({
      code: 'path-escape',
    });
    await expect(resolveContained(root, '../elsewhere/b.txt')).rejects.toMatchObject({
      code: 'path-escape',
    });
  });
});

describe('disk and hashing', () => {
  it('reports free space for an existing path and undefined for a missing one', async () => {
    expect(await freeDiskSpace(dir())).toBeGreaterThan(0);
    expect(await freeDiskSpace(join(dir(), 'nope'))).toBeUndefined();
  });

  it('hashes strings, bytes and files identically', async () => {
    const expected = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
    expect(hash('hello')).toBe(expected);
    expect(hash(Buffer.from('hello'))).toBe(expected);
    await writeFile(join(dir(), 'h.txt'), 'hello');
    expect(await hashFile(join(dir(), 'h.txt'))).toBe(expected);
    expect(await hashFile(join(dir(), 'h.txt'), 'sha512')).toBe(hash('hello', 'sha512'));
    expect(randomId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(randomId()).not.toBe(randomId());
  });
});
