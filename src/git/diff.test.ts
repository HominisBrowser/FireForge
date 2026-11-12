// SPDX-License-Identifier: EUPL-1.2
import { chmod, cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git as testGit, gitBytes as testGitBytes, initRepo } from '../testing/git.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import {
  changedPaths,
  diffTrees,
  diffWorktree,
  git,
  initRepository,
  resolveRevision,
  writeTree as writeTreeObject,
} from './index.js';

const dir = useTempDir();
const LATIN1 = Buffer.from('caf\xe9=Caf\xe9\ngr\xfcsse=Gr\xfcsse\n', 'latin1');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02]);

/** What git itself writes for the same change once it is staged, in the pinned format. */
async function stagedDiff(repo: string): Promise<Buffer> {
  await testGit(repo, ['add', '-A']);
  return testGitBytes(repo, [
    'diff',
    '--cached',
    '--binary',
    '--full-index',
    '--no-renames',
    '--src-prefix=a/',
    '--dst-prefix=b/',
    'HEAD',
  ]);
}

/** Applies `patch` with git in a fresh clone of `repo`'s HEAD and returns the clone. */
async function applyInClone(repo: string, patch: Buffer): Promise<string> {
  const clone = join(dir(), `clone-${Math.random().toString(16).slice(2)}`);
  await testGit(dir(), ['clone', '-q', repo, clone]);
  await testGit(clone, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(clone, '..', 'change.patch'), patch);
  await testGit(clone, ['apply', '--index', join(clone, '..', 'change.patch')]);
  return clone;
}

describe('diffWorktree', () => {
  it('equals what git writes for the staged change, byte for byte', async () => {
    const repo = join(dir(), 'repo');
    await initRepo(repo, {
      'tracked.js': 'const a = 1;\nconst b = 2;\n',
      'gone.js': 'bye\n',
      'run.sh': 'echo\n',
      'crlf.txt': 'a\r\nb\r\n',
      'toolkit/certs/cert.der': PNG,
    });
    await writeTree(repo, {
      'tracked.js': 'const a = 1;\nconst b = 3;',
      'crlf.txt': 'a\r\nB\r\n',
      'toolkit/certs/cert.der': Buffer.from([...PNG.subarray(0, 9), 0x09, 0x63]),
      'added.js': 'const c = 3;\n',
      'empty.js': '',
      'new dir/sp ace [1].txt': 'odd\n',
      'für.js': 'x\n',
    });
    await rm(join(repo, 'gone.js'));
    await chmod(join(repo, 'run.sh'), 0o755);

    const ours = await diffWorktree(repo);
    expect(ours.toString('utf8')).toContain('GIT binary patch');
    expect(ours.toString('utf8')).toContain('\\ No newline at end of file');
    expect(ours.equals(await stagedDiff(repo))).toBe(true);
  });

  it('is empty for a clean tree and leaves the index and status untouched', async () => {
    const repo = dir();
    await initRepo(repo, { 'a.txt': 'a\n' });
    expect((await diffWorktree(repo)).length).toBe(0);
    await writeTree(repo, { 'a.txt': 'b\n', 'icon.png': PNG });
    const index = await readFile(join(repo, '.git', 'index'));
    // The probe reads with the module's runner, which never refreshes the index itself.
    const probeStatus = (): Promise<string> =>
      git(['status', '--porcelain=v1', '-z'], { cwd: repo });
    const before = await probeStatus();
    const polled = new Set<string>();
    const state = { polling: true };
    const probe = (async (): Promise<void> => {
      while (state.polling) polled.add(await probeStatus());
    })();
    try {
      await diffWorktree(repo);
    } finally {
      state.polling = false;
      await probe;
    }
    expect([...polled]).toEqual([before]);
    expect((await readFile(join(repo, '.git', 'index'))).equals(index)).toBe(true);
  });

  it('carries a Latin-1 file as a binary section that applies byte for byte', async () => {
    const repo = join(dir(), 'repo');
    await initRepo(repo, {
      'tracked.properties': Buffer.from('k=caf\xe9\n', 'latin1'),
      'plain.js': 'a\n',
    });
    await writeTree(repo, {
      'tracked.properties': Buffer.from('k=caf\xe9!\n', 'latin1'),
      'browser/locales/en-US/app.properties': LATIN1,
      'odd name [1].properties': LATIN1,
      'utf8.properties': 'k=Grüße\n',
      'plain.js': 'b\n',
    });
    const patch = await diffWorktree(repo);
    const text = patch.toString('utf8');
    expect(text).not.toContain('�');
    expect(text.match(/GIT binary patch/g)).toHaveLength(3);
    expect(text).toContain('+k=Grüße');
    expect(text).toContain('+b');

    const clone = await applyInClone(repo, patch);
    for (const path of [
      'tracked.properties',
      'browser/locales/en-US/app.properties',
      'odd name [1].properties',
    ]) {
      expect(await readFile(join(clone, path))).toEqual(await readFile(join(repo, path)));
      expect((await testGit(clone, ['rev-parse', `:${path}`])).trim()).toBe(
        (await testGit(repo, ['hash-object', path])).trim()
      );
    }
  });

  it('carries tracked and new binary files as replayable payloads', async () => {
    const repo = join(dir(), 'repo');
    await initRepo(repo, { 'cert.der': PNG });
    const modified = Buffer.from([...PNG.subarray(0, 9), 0x09, 0x63]);
    await writeTree(repo, { 'cert.der': modified, 'icon.png': PNG });
    const patch = await diffWorktree(repo);
    expect(patch.toString('utf8')).not.toContain('Binary files');
    const clone = await applyInClone(repo, patch);
    expect(await readFile(join(clone, 'cert.der'))).toEqual(modified);
    expect(await readFile(join(clone, 'icon.png'))).toEqual(PNG);
  });

  it('scopes to paths, expands directories, and includes a named ignored file', async () => {
    const repo = dir();
    await initRepo(repo, {
      '.gitignore': '*.local\n',
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'gone/x.txt': 'x\n',
    });
    await writeTree(repo, {
      'a.txt': 'A\n',
      'b.txt': 'B\n',
      'new/one.txt': '1\n',
      'new/two.txt': '2\n',
      'new/skip.local': 's\n',
      'named.local': 'n\n',
    });
    await rm(join(repo, 'gone'), { recursive: true });
    const text = (
      await diffWorktree(repo, { paths: ['a.txt', 'new', 'gone', 'named.local', 'nowhere'] })
    ).toString();
    const headers = text.split('\n').filter((line) => line.startsWith('diff --git'));
    expect(headers).toEqual([
      'diff --git a/a.txt b/a.txt',
      'diff --git a/gone/x.txt b/gone/x.txt',
      'diff --git a/named.local b/named.local',
      'diff --git a/new/one.txt b/new/one.txt',
      'diff --git a/new/two.txt b/new/two.txt',
    ]);
    expect(text).toContain('deleted file mode 100644');
    expect(text).toMatch(/index 0{40}\.\.[0-9a-f]{40}\n--- \/dev\/null\n\+\+\+ b\/new\/one\.txt/);
  });

  it('diffs against another base and from an unborn HEAD', async () => {
    const repo = dir();
    const first = await initRepo(repo, { 'a.txt': 'one\n' });
    await writeTree(repo, { 'a.txt': 'two\n' });
    await testGit(repo, ['commit', '-qam', 'two']);
    await writeTree(repo, { 'a.txt': 'three\n' });
    const text = (await diffWorktree(repo, { base: first })).toString();
    expect(text).toContain('-one\n+three');
    await expect(diffWorktree(repo, { base: 'no-such-ref' })).rejects.toMatchObject({
      code: 'git-failed',
    });

    const unborn = join(dir(), 'unborn');
    await initRepository(unborn);
    await writeTree(unborn, { 'new.txt': 'n\n' });
    expect((await diffWorktree(unborn)).toString()).toContain('new file mode 100644');
  });
});

describe('diffTrees', () => {
  it('diffs trees built from content, scoped to paths, and lists changed paths', async () => {
    const repo = dir();
    await initRepo(repo, {
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'l.properties': Buffer.from('x=\xe9\n', 'latin1'),
    });
    const base = (await resolveRevision(repo, 'HEAD', 'tree')) ?? '';
    const next = await writeTreeObject(
      repo,
      [
        { path: 'a.txt', content: Buffer.from('A\n') },
        { path: 'b.txt', remove: true },
        { path: 'l.properties', content: Buffer.from('x=\xe8\n', 'latin1') },
      ],
      base
    );
    const all = (await diffTrees(repo, base, next)).toString('utf8');
    expect(all).toContain('-a\n+A');
    expect(all).toContain('deleted file mode');
    expect(all).toContain('GIT binary patch');
    const scoped = (await diffTrees(repo, base, next, { paths: ['a.txt'] })).toString();
    expect(scoped.split('\n').filter((line) => line.startsWith('diff --git'))).toEqual([
      'diff --git a/a.txt b/a.txt',
    ]);
    expect(await changedPaths(repo, base, next)).toEqual(['a.txt', 'b.txt', 'l.properties']);
    await writeTree(repo, { 'b.txt': 'changed\n' });
    expect(await changedPaths(repo, 'HEAD')).toEqual(['b.txt']);
  });

  it('applies to a copy of the old tree and reproduces the new one', async () => {
    const repo = join(dir(), 'repo');
    await initRepo(repo, { 'a.txt': 'a\n' });
    const copy = join(dir(), 'copy');
    await cp(repo, copy, { recursive: true });
    const base = (await resolveRevision(repo, 'HEAD', 'tree')) ?? '';
    const next = await writeTreeObject(
      repo,
      [{ path: 'a.txt', content: Buffer.from('b\n') }],
      base
    );
    await writeFile(join(dir(), 'p.patch'), await diffTrees(repo, base, next));
    await testGit(copy, ['apply', '--cached', join(dir(), 'p.patch')]);
    expect((await testGit(copy, ['write-tree'])).trim()).toBe(next);
  });
});
