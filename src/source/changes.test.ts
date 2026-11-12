// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { type ChangeSet, loadProject, textContent } from '../project/index.js';
import { git } from '../testing/git.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { override, requireSourceMode, sourceChanges, sourceStatus, verifySource } from './index.js';

const dir = useTempDir();
const MANIFEST = 'browser/manifest.txt';

async function fixture(): Promise<SourceFixture> {
  return createSourceFixture(dir());
}

/** Every change's diff, concatenated in change order. */
async function patchOf(set: ChangeSet): Promise<string> {
  const diff = set.diff;
  if (diff === undefined) throw new Error('a source change set has a diff provider');
  return (await Promise.all(set.changes.map((change) => diff(change)))).join('');
}

async function problemsOf(value: SourceFixture): Promise<Array<[string, string, boolean]>> {
  return (await verifySource(await value.load(), value.pristine)).map((problem) => [
    problem.kind,
    problem.path,
    problem.blocking,
  ]);
}

describe('the owned set', () => {
  it('reads tracked and untracked files, leaves out deleted ones, and reports ignored ones', async () => {
    const value = await fixture();
    await value.write({
      '.gitignore': '.fireforge/\nengine/\ndist/\n.DS_Store\n',
      'src/browser/kept.js': 'export const kept = 1;\n',
      'src/browser/gone.js': 'export const gone = 1;\n',
    });
    await value.commit();
    await value.remove('src/browser/gone.js');
    await value.write({
      'src/browser/untracked.js': 'export const fresh = 1;\n',
      'src/browser/dist/helper.mjs': 'export {};\n',
      'src/browser/.DS_Store': 'finder noise\n',
    });
    const status = await sourceStatus(await value.load(), value.pristine);
    expect(status.owned.map((entry) => [entry.path, entry.kind])).toEqual([
      ['browser/kept.js', 'create'],
      ['browser/untracked.js', 'create'],
    ]);
    expect(status.problems.map((problem) => [problem.kind, problem.path])).toEqual([
      ['ignored', 'src/browser/dist/helper.mjs'],
    ]);
  });

  it('gives two checkouts of one commit the same changes', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, MANIFEST);
    await value.write({ [`src/${MANIFEST}`]: 'first\nours\n', 'src/browser/new.js': 'new\n' });
    await value.commit();
    const linked = join(dir(), 'linked');
    await git(value.root, ['worktree', 'add', '--quiet', linked]);
    const fromMain = await sourceChanges(project, value.pristine);
    const fromLinked = await sourceChanges(
      requireSourceMode(await loadProject(linked)),
      value.pristine
    );
    expect(fromLinked.changes.map((change) => change.path)).toEqual([MANIFEST, 'browser/new.js']);
    expect(await patchOf(fromLinked)).toBe(await patchOf(fromMain));
  });

  it('reports undeclared, stale and orphaned records without blocking', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, 'browser/base/jar.mn');
    await override(project, value.pristine, 'toolkit/modules/Service.sys.mjs');
    await value.remove('src/toolkit/modules/Service.sys.mjs');
    await value.write({ [`src/${MANIFEST}`]: 'edited without a record\n' });
    await value.advance({ 'browser/base/jar.mn': 'browser.jar:\n  moved upstream\n' });
    const moved = (await git(value.pristine.repo, ['rev-parse', 'HEAD'])).trim();
    const status = await sourceStatus(project, { repo: value.pristine.repo, commit: moved });
    expect(
      status.problems.map((problem) => [problem.kind, problem.path, problem.blocking])
    ).toEqual([
      ['stale', 'browser/base/jar.mn', false],
      ['undeclared', MANIFEST, false],
      ['orphaned', 'toolkit/modules/Service.sys.mjs', false],
      ['stale', 'toolkit/modules/Service.sys.mjs', false],
    ]);
    expect(status.owned.map((entry) => [entry.path, entry.kind])).toEqual([
      ['browser/base/jar.mn', 'modify'],
      [MANIFEST, 'modify'],
    ]);
  });

  it('refuses links, case collisions, tombstones with files and paths upstream blocks', async () => {
    const value = await fixture();
    const project = await value.load();
    await mkdir(join(value.root, 'src/browser'), { recursive: true });
    await symlink('/nonexistent', join(value.root, 'src/browser/link.js'));
    const record = {
      kind: 'delete',
      base: { commit: value.pristine.commit, blob: 'a'.repeat(40), mode: '100644' },
      component: 'toolkit',
      classification: 'registration',
    };
    await value.write({
      'src/toolkit/thing.js': 'one spelling\n',
      '.fireforge-sources/overrides/TOOLKIT/thing.js.json': JSON.stringify(record),
      'src/browser/manifest.txt/inner.js': 'under an upstream file\n',
    });
    await override(project, value.pristine, 'browser/run.sh', { delete: true });
    await value.write({ 'src/browser/run.sh': 'back\n' });
    const problems = await problemsOf(value);
    expect(problems).toEqual(
      expect.arrayContaining([
        ['case-collision', 'TOOLKIT/thing.js', true],
        ['case-collision', 'toolkit/thing.js', true],
        ['unsupported-kind', 'browser/link.js', true],
        ['path-conflict', 'browser/manifest.txt/inner.js', true],
        ['tombstone-has-file', 'browser/run.sh', true],
      ])
    );
    expect((await sourceChanges(project, value.pristine)).changes).toEqual([]);
  });

  it('accepts a created file under a tombstoned upstream file', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, MANIFEST, { delete: true });
    await value.write({ 'src/browser/manifest.txt/inner.js': 'replaces the file\n' });
    const changes = await sourceChanges(project, value.pristine);
    expect(changes.changes.map((change) => [change.path, change.kind])).toEqual([
      [MANIFEST, 'delete'],
      ['browser/manifest.txt/inner.js', 'create'],
    ]);
    expect(await verifySource(project, value.pristine)).toEqual([]);
  });

  it('refuses attributes that could change committed bytes, and keeps CRLF under -text', async () => {
    const value = await fixture();
    await value.write({ '.gitattributes': '* text=auto\n' });
    await value.remove('src/.gitattributes');
    await value.commit();
    await value.write({ 'src/browser/crlf.txt': Buffer.from('a\r\nb\r\n') });
    expect(await problemsOf(value)).toEqual([['filtered', 'browser/crlf.txt', false]]);
    await value.write({ 'src/.gitattributes': '* -text\n' });
    expect(await problemsOf(value)).toEqual([]);
    expect(await patchOf(await sourceChanges(await value.load(), value.pristine))).toContain(
      '+a\r\n'
    );
  });
});

describe('the change set', () => {
  it('groups by component and created-file group, with byte-exact replayable diffs', async () => {
    const value = await fixture();
    const project = await value.load();
    await override(project, value.pristine, MANIFEST, { component: '012-ui-sidebar.patch' });
    await override(project, value.pristine, 'browser/blob.dat', {
      component: 'infra-registration',
    });
    await override(project, value.pristine, 'browser/run.sh', {
      delete: true,
      component: 'infra-registration',
    });
    await value.write(
      {
        [`src/${MANIFEST}`]: 'first\nlocal\nthird\nfourth\nfifth\n',
        'src/browser/blob.dat': Buffer.from([9, 0, 255]),
        'src/browser/latin.txt': Buffer.from([0xff, 0xfe, 10]),
        'src/browser/tool.sh': '#!/bin/sh\n',
      },
      { executable: ['src/browser/tool.sh'] }
    );
    const changes = await sourceChanges(project, value.pristine);
    expect(changes.groups.map((group) => group.id)).toEqual([
      '012-ui-sidebar.patch',
      'infra-registration',
      'created-root',
    ]);
    expect(
      changes.changes.map((change) => [change.path, change.kind, change.group, change.binary])
    ).toEqual([
      [MANIFEST, 'modify', '012-ui-sidebar.patch', false],
      ['browser/blob.dat', 'modify', 'infra-registration', true],
      ['browser/run.sh', 'delete', 'infra-registration', false],
      ['browser/latin.txt', 'create', 'created-root', true],
      ['browser/tool.sh', 'create', 'created-root', false],
    ]);
    const modify = changes.final(MANIFEST);
    if (modify?.kind !== 'modify') throw new Error('expected a modify');
    expect(textContent(await modify.before())).toBe('first\nsecond\nthird\nfourth\nfifth\n');
    expect(modify.meta).toMatchObject({ component: '012-ui-sidebar.patch', declared: true });
    const patch = await patchOf(changes);
    expect(patch).toContain('GIT binary patch');
    // Windows has no executable bit.
    if (process.platform !== 'win32') {
      expect(patch).toContain('new file mode 100755');
      expect(patch).toContain('deleted file mode 100755');
    }
    // The diff replays onto the pristine checkout byte for byte.
    const replay = await value.engine(join(dir(), 'replay'));
    await writeFile(join(dir(), 'all.patch'), patch);
    await git(replay, ['apply', '--binary', join(dir(), 'all.patch')]);
    expect(await readFile(join(replay, 'browser/blob.dat'))).toEqual(Buffer.from([9, 0, 255]));
    expect(await readFile(join(replay, 'browser/latin.txt'))).toEqual(
      Buffer.from([0xff, 0xfe, 10])
    );
    if (process.platform !== 'win32') {
      expect((await stat(join(replay, 'browser/tool.sh'))).mode & 0o111).not.toBe(0);
    }
    await expect(readFile(join(replay, 'browser/run.sh'))).rejects.toThrow();
  });
});
