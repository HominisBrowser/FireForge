// SPDX-License-Identifier: EUPL-1.2
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../testing/git.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';
import { discard, enginePaths, importQueue, queueStatus, resetEngine } from './index.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const SERVICE = 'toolkit/components/example/service.sys.mjs';
const MOZCONFIGURE = 'browser/moz.configure';
const NEW = 'browser/components/mine/new.js';

async function imported(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('ui-new', { [NEW]: 'export const fresh = 1;\n' });
  await fixture.addPatch('ui-more', {
    [BROWSER]: 'export const browserTitle = "patched";\nexport const more = 1;\n',
  });
  await fixture.addPatch('ui-cleanup', { [SERVICE]: null });
  return fixture;
}

async function snapshotRef(fixture: PatchFixture): Promise<string> {
  const refs = await git(fixture.engine, [
    'for-each-ref',
    '--format=%(refname)',
    'refs/fireforge/recovery/',
  ]);
  return refs.trim().split('\n').at(-1) ?? '';
}

describe('discard', () => {
  it('puts queue files back to the queue baseline and other files back to upstream', async () => {
    const fixture = await imported();
    await fixture.edit({
      [BROWSER]: 'export const browserTitle = "edited";\n',
      [NEW]: 'broken\n',
      [SERVICE]: 'resurrected\n',
      [MOZCONFIGURE]: 'edited\n',
    });
    const result = await discard(await fixture.project(), [BROWSER, NEW, SERVICE, MOZCONFIGURE]);
    expect(result.paths.map((entry) => [entry.path, entry.was, entry.to, entry.owners])).toEqual([
      [BROWSER, 'modified', 'queue', ['001-ui-title.patch', '003-ui-more.patch']],
      [NEW, 'modified', 'queue', ['002-ui-new.patch']],
      [MOZCONFIGURE, 'unmanaged', 'upstream', []],
      [SERVICE, 'modified', 'queue', ['004-ui-cleanup.patch']],
    ]);
    expect(await fixture.read(BROWSER)).toBe(
      'export const browserTitle = "patched";\nexport const more = 1;\n'
    );
    expect(await fixture.read(NEW)).toBe('export const fresh = 1;\n');
    expect(await fixture.read(SERVICE)).toBeUndefined();
    expect(await fixture.read(MOZCONFIGURE)).toBe('imply_option("MOZ_APP_VENDOR", "Mozilla")\n');
    expect(await git(fixture.engine, ['show', `${result.snapshot ?? ''}:${BROWSER}`])).toBe(
      'export const browserTitle = "edited";\n'
    );
  });

  it('re-creates a deleted queue file, and applies an unapplied one', async () => {
    const fixture = await imported();
    await fixture.edit({ [NEW]: null });
    await git(fixture.engine, ['checkout', '--', BROWSER]);
    await discard(await fixture.project(), ['browser']);
    expect(await fixture.read(NEW)).toBe('export const fresh = 1;\n');
    expect(await fixture.read(BROWSER)).toContain('more = 1');
  });

  it('deletes untracked files and prunes the directories that empties', async () => {
    const fixture = await imported();
    await fixture.edit({
      'browser/scratch/deep/a.txt': 'a\n',
      'browser/scratch/b.txt': 'b\n',
      'browser/keep/c.txt': 'c\n',
      'browser/keep/d.txt': 'd\n',
    });
    const project = await fixture.project();
    await discard(project, ['browser/scratch/deep/a.txt']);
    expect(await readdir(join(fixture.engine, 'browser/scratch'))).toEqual(['b.txt']);
    await discard(project, ['browser/scratch', 'browser/keep/c.txt']);
    expect(await readdir(join(fixture.engine, 'browser'))).not.toContain('scratch');
    expect(await readdir(join(fixture.engine, 'browser/keep'))).toEqual(['d.txt']);
    expect(
      await git(fixture.engine, ['show', `${await snapshotRef(fixture)}:browser/keep/c.txt`])
    ).toBe('c\n');
  });

  it('unstages staged edits and staged additions', async () => {
    const fixture = await imported();
    await fixture.edit({ [BROWSER]: 'staged\n', 'browser/added.js': 'added\n' });
    await git(fixture.engine, ['add', BROWSER, 'browser/added.js']);
    await discard(await fixture.project(), [BROWSER, 'browser/added.js']);
    expect(await fixture.read(BROWSER)).toContain('more = 1');
    expect(await fixture.read('browser/added.js')).toBeUndefined();
    expect((await git(fixture.engine, ['diff', '--cached', '--name-only'])).trim()).toBe('');
  });

  it('discards nothing where nothing changed', async () => {
    const fixture = await imported();
    expect(await discard(await fixture.project(), [BROWSER])).toEqual({
      paths: [],
      snapshot: undefined,
    });
  });

  it('refuses while the manifest is unreadable', async () => {
    const fixture = await imported();
    await fixture.edit({ [BROWSER]: 'edited\n' });
    await writeFile(join(fixture.patches, 'patches.json'), '{"version": 2}');
    await expect(discard(await fixture.project(), [BROWSER])).rejects.toMatchObject({
      code: 'queue-manifest-invalid',
    });
    expect(await fixture.read(BROWSER)).toBe('edited\n');
  });
});

describe('enginePaths', () => {
  it('reads paths as engine-relative, or relative to a directory inside the engine', () => {
    expect(enginePaths('/p/engine', '/p', ['browser/a.js', '/p/engine/b.js', '.'])).toEqual([
      'browser/a.js',
      'b.js',
      '',
    ]);
    expect(enginePaths('/p/engine', '/p/engine/browser', ['a.js'])).toEqual(['browser/a.js']);
    expect(() => enginePaths('/p/engine', '/p', ['../x'])).toThrow(
      expect.objectContaining({ code: 'path-outside-engine' })
    );
  });
});

describe('resetEngine', () => {
  it('drops tracked edits, staged additions and untracked files after a snapshot, and keeps build output', async () => {
    const fixture = await imported();
    await fixture.edit({
      'browser/added.js': 'added\n',
      'browser/untracked.js': 'u\n',
      'obj-fireforge/out.o': 'o',
    });
    await git(fixture.engine, ['add', 'browser/added.js']);
    const project = await fixture.project();
    const result = await resetEngine(project);
    expect(result.changed).toBe(true);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "baseline";\n');
    expect(await fixture.read('browser/added.js')).toBeUndefined();
    expect(await fixture.read('browser/untracked.js')).toBeUndefined();
    expect(await fixture.read(NEW)).toBeUndefined();
    expect(await fixture.read('obj-fireforge/out.o')).toBe('o');
    expect(
      await git(fixture.engine, ['show', `${result.snapshot ?? ''}:browser/untracked.js`])
    ).toBe('u\n');
    expect((await git(fixture.engine, ['status', '--porcelain'])).trim()).toBe('');
    expect(await resetEngine(project)).toEqual({ changed: false, snapshot: undefined });
  });

  it('drops a paused import with it', async () => {
    const fixture = await imported();
    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    const project = await fixture.project();
    await expect(importQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await resetEngine(project);
    expect((await queueStatus(project)).session).toBeUndefined();
  });
});
