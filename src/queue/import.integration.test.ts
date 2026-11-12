// SPDX-License-Identifier: EUPL-1.2
import { chmod, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../testing/git.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';
import {
  deletePatch,
  exportPatch,
  importQueue,
  mutateQueue,
  queueStatus,
  reExport,
  regeneratePatchBody,
  resolvePatchFromEngine,
} from './index.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const SERVICE = 'toolkit/components/example/service.sys.mjs';
const MOZBUILD = 'browser/modules/moz.build';

async function twoPatches(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
  await fixture.resetEngine();
  return fixture;
}

describe('importQueue', () => {
  it('applies the queue in order and writes only the files it touches', async () => {
    const fixture = await twoPatches();
    const run = await importQueue(await fixture.project());
    expect(run.patches.map((patch) => [patch.patch, patch.status])).toEqual([
      ['001-ui-title.patch', 'applied-clean'],
      ['002-infra-dirs.patch', 'applied-clean'],
    ]);
    expect(run.written).toEqual([BROWSER, MOZBUILD]);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
    expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["newtab"]\nDIRS += ["mine"]\n');
    expect((await git(fixture.engine, ['diff', '--cached', '--name-only'])).trim()).toBe('');
  });

  it('changes nothing when imported twice', async () => {
    const fixture = await twoPatches();
    const project = await fixture.project();
    await importQueue(project);
    const again = await importQueue(project);
    expect(again.written).toEqual([]);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
  });

  it('keeps edits to files the queue does not touch', async () => {
    const fixture = await twoPatches();
    await fixture.edit({ [SERVICE]: 'export const version = 2;\n', 'browser/new.js': '// mine\n' });
    await importQueue(await fixture.project());
    expect(await fixture.read(SERVICE)).toBe('export const version = 2;\n');
    expect(await fixture.read('browser/new.js')).toBe('// mine\n');
  });

  it('refuses to overwrite an unexported edit in a queue file, and --force keeps it in a snapshot', async () => {
    const fixture = await twoPatches();
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "my edit";\n' });
    const project = await fixture.project();
    await expect(importQueue(project)).rejects.toMatchObject({
      code: 'engine-unexported-edits',
      message: expect.stringContaining(BROWSER) as string,
    });
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "my edit";\n');

    await importQueue(project, { force: true });
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
    const refs = await git(fixture.engine, [
      'for-each-ref',
      '--format=%(refname)',
      'refs/fireforge/recovery/',
    ]);
    const ref = refs.trim().split('\n')[0] ?? '';
    expect(await git(fixture.engine, ['show', `${ref}:${BROWSER}`])).toBe(
      'export const browserTitle = "my edit";\n'
    );
  });

  it('completes from a partly applied engine', async () => {
    const fixture = await twoPatches();
    await fixture.edit({ [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
    await importQueue(await fixture.project());
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
  });

  it('stops after --until and leaves later patches unapplied', async () => {
    const fixture = await twoPatches();
    const project = await fixture.project();
    await importQueue(project);
    const run = await importQueue(project, { until: 'ui-title' });
    expect(run.patches.map((patch) => patch.status)).toEqual(['applied-clean']);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
    expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["newtab"]\n');
    await expect(importQueue(project, { until: '7' })).rejects.toMatchObject({
      code: 'patch-not-found',
    });
  });

  it('applies overlapping patches to one file in sequence', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
    await fixture.addPatch('ui-more', {
      [BROWSER]: 'export const browserTitle = "patched";\nexport const more = true;\n',
    });
    await fixture.resetEngine();
    await importQueue(await fixture.project());
    expect(await fixture.read(BROWSER)).toBe(
      'export const browserTitle = "patched";\nexport const more = true;\n'
    );
  });

  it('creates, deletes and replaces binary files', async () => {
    const fixture = await createPatchProject(dir());
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0xff]);
    await fixture.addPatch('branding-assets', {
      'browser/branding/mine/icon.png': png,
      'browser/branding/unofficial/default16.png': Buffer.from([0, 0, 0, 7]),
      [SERVICE]: null,
    });
    await fixture.resetEngine();
    await importQueue(await fixture.project());
    expect(await readFile(join(fixture.engine, 'browser/branding/mine/icon.png'))).toEqual(png);
    expect(
      await readFile(join(fixture.engine, 'browser/branding/unofficial/default16.png'))
    ).toEqual(Buffer.from([0, 0, 0, 7]));
    expect(await fixture.read(SERVICE)).toBeUndefined();
  });

  it('refuses a damaged manifest and leaves the engine alone', async () => {
    const fixture = await twoPatches();
    await writeFile(join(fixture.patches, 'patches.json'), '{ "version": 2, "patches": [ ');
    await expect(importQueue(await fixture.project())).rejects.toMatchObject({
      code: 'json-invalid',
    });
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "baseline";\n');
  });
});

/** A queue whose second patch no longer applies after the first was rewritten. */
async function conflicting(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('ui-more', {
    [BROWSER]: 'export const browserTitle = "patched-more";\n',
    [SERVICE]: 'export const version = 2;\n',
  });
  await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
  await fixture.resetEngine();
  const project = await fixture.project();
  const head = (await git(fixture.engine, ['rev-parse', 'HEAD^{tree}'])).trim();
  await fixture.edit({ [BROWSER]: 'export const browserTitle = "other";\n' });
  const { body } = await regeneratePatchBody(fixture.engine, { before: head, paths: [BROWSER] });
  await mutateQueue(project, 'test', (draft) => {
    const first = draft.patches.find((patch) => patch.name === 'ui-title');
    if (first !== undefined) first.body = body;
  });
  await fixture.resetEngine();
  return fixture;
}

describe('a paused import', () => {
  it('stops at the failing patch with its hunks and .rej files, then resolve and --continue finish it', async () => {
    const fixture = await conflicting();
    const project = await fixture.project();
    await expect(importQueue(project)).rejects.toMatchObject({
      code: 'patch-failed',
      message: expect.stringContaining('002-ui-more.patch') as string,
    });
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "other";\n');
    expect(await fixture.read(SERVICE)).toBe('export const version = 2;\n');
    expect(await fixture.read(`${BROWSER}.rej`)).toContain('patched-more');
    expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["newtab"]\n');
    const paused = await queueStatus(project);
    expect(paused.session).toMatchObject({
      kind: 'import',
      done: 1,
      total: 3,
      current: { patch: '002-ui-more.patch', status: 'failed' },
      rejects: [`${BROWSER}.rej`],
    });

    await fixture.edit({ [BROWSER]: 'export const browserTitle = "other-more";\n' });
    const resolution = await resolvePatchFromEngine(project);
    expect(resolution).toEqual({ patch: '002-ui-more.patch', files: [BROWSER, SERVICE] });
    const body = await readFile(join(fixture.patches, '002-ui-more.patch'), 'utf8');
    expect(body).toContain('-export const browserTitle = "other";');
    expect(body).toContain('+export const browserTitle = "other-more";');
    expect(await fixture.read(`${BROWSER}.rej`)).toBeUndefined();

    const run = await importQueue(project, { continue: true });
    expect(run.patches.map((patch) => patch.status)).toEqual([
      'applied-clean',
      'resolved',
      'applied-clean',
    ]);
    expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["newtab"]\nDIRS += ["mine"]\n');
    const done = await queueStatus(project);
    expect(done.session).toBeUndefined();
    expect(done.paths.filter((path) => path.state !== 'clean')).toEqual([]);
  });

  it('--continue rewrites the failed patch and applies the rest in one step', async () => {
    const fixture = await conflicting();
    const project = await fixture.project();
    await expect(importQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "other-more";\n' });
    const run = await importQueue(project, { continue: true });
    expect(run.patches.map((patch) => patch.status)).toEqual([
      'applied-clean',
      'resolved',
      'applied-clean',
    ]);
    await importQueue(project);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "other-more";\n');
  });

  it('refuses to resolve without a paused import, or with nothing to record', async () => {
    const fixture = await conflicting();
    const project = await fixture.project();
    await expect(resolvePatchFromEngine(project)).rejects.toMatchObject({ code: 'no-session' });
    await expect(importQueue(project, { continue: true })).rejects.toMatchObject({
      code: 'no-session',
    });
    await expect(importQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({
      [SERVICE]: 'export const version = 1;\n',
      [BROWSER]: 'export const browserTitle = "other";\n',
    });
    await expect(resolvePatchFromEngine(project)).rejects.toMatchObject({ code: 'resolve-empty' });
    await fixture.upstream({ 'browser/moz.configure': 'moved\n' });
    await expect(importQueue(project, { continue: true })).rejects.toMatchObject({
      code: 'session-stale',
    });
  });
});

describe('resuming a paused import', () => {
  it('never lets a later new-file section replace a file an earlier patch created', async () => {
    const created = 'browser/base/content/mine.js';
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-new', { [created]: 'v1\n' });
    await fixture.resetEngine();
    const mod = await fixture.addPatch('ui-mod', {
      [BROWSER]: 'export const browserTitle = "patched";\n',
    });
    await fixture.resetEngine();
    await fixture.addPatch('ui-dup', { [created]: 'v3\n' });
    await fixture.resetEngine();
    const body = await readFile(mod.path, 'utf8');
    await writeFile(mod.path, body.replace(/^-.*$/m, '-something else entirely'));
    const project = await fixture.project();
    await expect(importQueue(project)).rejects.toMatchObject({ code: 'patch-failed' });
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "patched";\n' });
    await expect(importQueue(project, { continue: true })).rejects.toMatchObject({
      code: 'patch-failed',
      message: expect.stringContaining('003-ui-dup.patch') as string,
    });
    expect(await fixture.read(created)).toBe('v1\n');
  });
});

describe('a queue that changed underneath the engine', () => {
  it('brings the engine up to date after a pulled patch, without calling it an edit', async () => {
    const fixture = await createPatchProject(dir());
    const patch = await fixture.addPatch('ui-title', {
      [BROWSER]: 'export const browserTitle = "v1";\n',
    });
    await fixture.resetEngine();
    const project = await fixture.project();
    await importQueue(project);
    // A teammate's version of the patch arrives with a pull.
    await writeFile(patch.path, (await readFile(patch.path, 'utf8')).replaceAll('"v1"', '"v2"'));
    const status = await queueStatus(project);
    expect(status.paths.find((path) => path.path === BROWSER)?.state).toBe('outdated');
    // Re-exporting does not turn the old import into an edit that reverts the pull.
    const reExported = await reExport(project, { all: true });
    expect(reExported.patches.map((entry) => entry.status)).toEqual(['unchanged']);
    expect(await readFile(patch.path, 'utf8')).toContain('"v2"');
    await importQueue(project);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "v2";\n');
  });

  it('puts back what a patch no longer in the queue wrote, unless it was edited since', async () => {
    const fixture = await twoPatches();
    const project = await fixture.project();
    await importQueue(project);
    // Another branch of the project, without either patch.
    await mutateQueue(project, 'the branch switch', (draft) => {
      draft.patches = [];
    });
    await fixture.edit({ [MOZBUILD]: 'DIRS += ["mine, edited"]\n' });
    expect((await queueStatus(project)).paths).toEqual([
      { path: BROWSER, state: 'outdated', owners: [] },
      { path: MOZBUILD, state: 'unmanaged', owners: [] },
    ]);
    await importQueue(project);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "baseline";\n');
    expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["mine, edited"]\n');
  });

  it("keeps the files of a deleted patch as the user's work", async () => {
    const fixture = await twoPatches();
    const project = await fixture.project();
    await importQueue(project);
    await deletePatch(project, 'ui-title');
    expect((await queueStatus(project)).paths).toContainEqual({
      path: BROWSER,
      state: 'unmanaged',
      owners: [],
    });
    await importQueue(project);
    expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "patched";\n');
  });
});

describe('engine writes', () => {
  it('imports a symlink a patch creates', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.edit({ 'browser/aaa.js': '// new\n' });
    await symlink('aaa.js', join(fixture.engine, 'browser', 'zzz-link.js'));
    await exportPatch(await fixture.project(), { all: true, name: 'ui-link' });
    await fixture.resetEngine();
    await importQueue(await fixture.project());
    expect(await readlink(join(fixture.engine, 'browser', 'zzz-link.js'))).toBe('aaa.js');
    expect(await fixture.read('browser/aaa.js')).toBe('// new\n');
  });

  // Windows does not make a directory read-only through its mode.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'leaves the engine as it was when a write fails half-way',
    async () => {
      const fixture = await twoPatches();
      const project = await fixture.project();
      // browser/base/content is written first; browser/modules refuses the second write.
      await chmod(join(fixture.engine, 'browser/modules'), 0o500);
      try {
        await expect(importQueue(project)).rejects.toThrow();
      } finally {
        await chmod(join(fixture.engine, 'browser/modules'), 0o755);
      }
      expect(await fixture.read(BROWSER)).toBe('export const browserTitle = "baseline";\n');
      expect(await fixture.read(MOZBUILD)).toBe('DIRS += ["newtab"]\n');
      expect((await queueStatus(project)).session).toBeUndefined();
    }
  );
});
