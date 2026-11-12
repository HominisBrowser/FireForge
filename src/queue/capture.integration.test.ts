// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MINIMAL_CONFIG } from '../testing/config.js';
import { git } from '../testing/git.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import {
  exportPatch,
  importQueue,
  mutateQueue,
  queueChanges,
  queueStatus,
  reExport,
  retirePatch,
  verifyQueue,
} from './index.js';
import { loadQueue } from './queue.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const SERVICE = 'toolkit/components/example/service.sys.mjs';
const MOZBUILD = 'browser/modules/moz.build';
const PNG = 'browser/branding/unofficial/default16.png';
const PANEL = 'browser/components/panel/panel.mjs';
const PANEL_CSS = 'browser/components/panel/panel.css';

const lines = (count: number, edit: (copy: string[]) => void = () => undefined): string => {
  const copy = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  edit(copy);
  return `${copy.join('\n')}\n`;
};

/**
 * A queue with every kind of step: a created file another patch changes
 * further (overlap), a binary change, a deletion, a plain modification.
 */
async function overlapping(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-panel', {
    [PANEL]: lines(30),
    [PANEL_CSS]: '.panel {}\n',
  });
  await fixture.addPatch('branding-icon', { [PNG]: Buffer.from([0, 1, 2, 3, 0, 255]) });
  await fixture.addPatch('ui-cleanup', { [SERVICE]: null });
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('ui-panel-more', {
    [PANEL]: lines(30, (copy) => (copy[24] = 'line 25 from more')),
  });
  return fixture;
}

async function patchText(fixture: PatchFixture, filename: string): Promise<string> {
  return readFile(join(fixture.patches, filename), 'utf8');
}

/** Every queue path is clean and nothing is unexported: the queue reproduces the engine. */
async function expectReproduced(fixture: PatchFixture): Promise<void> {
  const project = await fixture.project();
  const status = await queueStatus(project);
  expect(status.paths.filter((path) => path.state !== 'clean')).toEqual([]);
  expect((await verifyQueue(project)).problems).toEqual([]);
}

describe('reExport', () => {
  it('is a byte-for-byte no-op on an unchanged engine', async () => {
    const fixture = await overlapping();
    const before = await readTree(fixture.patches);
    const result = await reExport(await fixture.project(), { all: true });
    expect(result.patches.map((patch) => patch.status)).toEqual(Array(5).fill('unchanged'));
    expect(await readTree(fixture.patches)).toEqual(before);
  });

  it('gives an edit to the only patch that changes the file', async () => {
    const fixture = await overlapping();
    const ui = await patchText(fixture, '001-ui-panel.patch');
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "edited";\n' });
    const result = await reExport(await fixture.project(), { all: true });
    expect(result.patches.filter((patch) => patch.status === 'rewritten')).toEqual([
      {
        patch: '004-ui-title.patch',
        status: 'rewritten',
        adopted: [],
        dropped: [],
        stamped: false,
      },
    ]);
    expect(await patchText(fixture, '004-ui-title.patch')).toContain(
      '+export const browserTitle = "edited";'
    );
    expect(await patchText(fixture, '001-ui-panel.patch')).toBe(ui);
    await expectReproduced(fixture);
  });

  it('gives an edit to a shared file to the patch whose lines it touches', async () => {
    const fixture = await overlapping();
    const more = await patchText(fixture, '005-ui-panel-more.patch');
    await fixture.edit({
      [PANEL]: lines(30, (copy) => {
        copy[2] = 'line 3 edited';
        copy[24] = 'line 25 from more';
      }),
    });
    const result = await reExport(await fixture.project(), { all: true });
    expect(await patchText(fixture, '001-ui-panel.patch')).toContain('+line 3 edited');
    expect(await patchText(fixture, '005-ui-panel-more.patch')).toBe(more);
    expect(result.patches.filter((entry) => entry.status === 'rewritten')).toMatchObject([
      { patch: '001-ui-panel.patch' },
    ]);
    await expectReproduced(fixture);
  });

  it("gives an edit touching several patches' lines to the last patch changing the file", async () => {
    const fixture = await overlapping();
    const first = await patchText(fixture, '001-ui-panel.patch');
    await fixture.edit({
      [PANEL]: lines(30, (copy) => {
        copy[2] = 'line 3 edited';
        copy[24] = 'line 25 edited';
      }),
    });
    await reExport(await fixture.project(), { all: true });
    expect(await patchText(fixture, '001-ui-panel.patch')).toBe(first);
    const more = await patchText(fixture, '005-ui-panel-more.patch');
    expect(more).toContain('+line 3 edited');
    expect(more).toContain('+line 25 edited');
    await expectReproduced(fixture);
  });

  it('gives the edit to an earlier patch when only it is re-exported, keeping later ones applying', async () => {
    const fixture = await overlapping();
    const later = await patchText(fixture, '005-ui-panel-more.patch');
    await fixture.edit({
      [PANEL]: lines(30, (copy) => {
        copy[2] = 'line 3 edited';
        copy[24] = 'line 25 from more';
      }),
    });
    await reExport(await fixture.project(), { patches: ['ui-panel'] });
    expect(await patchText(fixture, '001-ui-panel.patch')).toContain('+line 3 edited');
    expect(await patchText(fixture, '005-ui-panel-more.patch')).toBe(later);
    await expectReproduced(fixture);
    await fixture.resetEngine();
    await importQueue(await fixture.project());
    expect(await fixture.read(PANEL)).toContain('line 3 edited');
  });

  it('refuses to give an earlier patch an edit to lines a later patch changes', async () => {
    const fixture = await overlapping();
    const before = await readTree(fixture.patches);
    await fixture.edit({ [PANEL]: lines(30, (copy) => (copy[24] = 'line 25 rewritten')) });
    await expect(
      reExport(await fixture.project(), { patches: ['ui-panel'] })
    ).rejects.toMatchObject({
      code: 're-export-overlap',
      hint: expect.stringContaining('005-ui-panel-more.patch') as string,
    });
    expect(await readTree(fixture.patches)).toEqual(before);
  });

  it('captures the deletion of an upstream file the patch changes', async () => {
    const fixture = await overlapping();
    await fixture.edit({ [BROWSER]: null });
    await reExport(await fixture.project(), { patches: ['ui-title'] });
    expect(await patchText(fixture, '004-ui-title.patch')).toContain('deleted file mode');
    await expectReproduced(fixture);
    await fixture.resetEngine();
    await importQueue(await fixture.project());
    expect(await fixture.read(BROWSER)).toBeUndefined();
  });

  it('drops a created file the engine no longer has, and refuses to empty a patch', async () => {
    const fixture = await overlapping();
    await fixture.edit({ [PANEL_CSS]: null });
    const result = await reExport(await fixture.project(), { patches: ['ui-panel'] });
    expect(result.patches[0]).toMatchObject({ status: 'rewritten', dropped: [PANEL_CSS] });
    expect((await loadQueue(await fixture.project())).patches[0]?.files).toEqual([PANEL]);
    await expectReproduced(fixture);

    await fixture.edit({ [BROWSER]: 'export const browserTitle = "baseline";\n' });
    await expect(
      reExport(await fixture.project(), { patches: ['ui-title'] })
    ).rejects.toMatchObject({ code: 're-export-empty' });
  });

  it('round-trips a binary change as a GIT binary patch', async () => {
    const fixture = await overlapping();
    await fixture.edit({ [PNG]: Buffer.from([9, 8, 7, 0, 6]) });
    await reExport(await fixture.project(), { patches: ['branding-icon'] });
    const body = await patchText(fixture, '002-branding-icon.patch');
    expect(body).toContain('GIT binary patch');
    expect(body).not.toContain('Binary files');
    await expectReproduced(fixture);
  });

  it('with scan, adopts unowned edits in the directory of a patch file, not below it', async () => {
    const fixture = await overlapping();
    const fonts = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `browser/components/panel/face-${index}.woff2`,
        Buffer.from([0x77, 0x4f, 0x46, 0x32, 0, index]),
      ])
    );
    await fixture.edit({
      ...fonts,
      'browser/components/panel/helper.mjs': 'export const help = 1;\n',
      'browser/components/panel/deep/nested.mjs': '// not adjacent\n',
    });
    const project = await fixture.project();
    const preview = await reExport(project, {
      patches: ['ui-panel-more'],
      scan: true,
      dryRun: true,
    });
    expect(preview.patches[0]?.adopted).toEqual([
      ...Object.keys(fonts),
      'browser/components/panel/helper.mjs',
    ]);
    expect(preview.changes?.group('005-ui-panel-more.patch')).toBeDefined();
    expect(preview.changes?.at('browser/components/panel/helper.mjs')).toHaveLength(1);
    expect((await loadQueue(project)).patches[4]?.files).toEqual([PANEL]);

    await reExport(project, { patches: ['ui-panel-more'], scan: true });
    const files = (await loadQueue(project)).patches[4]?.files ?? [];
    expect(files).toContain('browser/components/panel/face-7.woff2');
    expect(files).not.toContain('browser/components/panel/deep/nested.mjs');
    const status = await queueStatus(project);
    expect(status.paths.filter((path) => path.state === 'unmanaged').map((p) => p.path)).toEqual([
      'browser/components/panel/deep/nested.mjs',
    ]);
  });

  it('stamps only the selected patches, and only with stamp', async () => {
    const fixture = await overlapping();
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    await reExport(project, { patches: ['ui-title'] });
    expect((await loadQueue(project)).patches.map((patch) => patch.firefox.version)).toEqual(
      Array(5).fill('140.9.0esr')
    );
    const result = await reExport(project, { patches: ['ui-title', 'ui-cleanup'], stamp: true });
    expect(result.patches.map((patch) => patch.stamped)).toEqual([true, true]);
    expect((await loadQueue(project)).patches.map((patch) => patch.firefox.version)).toEqual([
      '140.9.0esr',
      '140.9.0esr',
      '141.0esr',
      '141.0esr',
      '140.9.0esr',
    ]);
  });

  it('writes nothing on a dry run, and refuses while an import is paused', async () => {
    const fixture = await overlapping();
    await fixture.edit({ [BROWSER]: 'export const browserTitle = "edited";\n' });
    const before = await readTree(fixture.patches);
    const preview = await reExport(await fixture.project(), { all: true, dryRun: true });
    expect(preview.patches.map((patch) => patch.status)).toContain('rewritten');
    expect(await readTree(fixture.patches)).toEqual(before);

    await fixture.upstream({ [BROWSER]: 'export const browserTitle = "upstream";\n' });
    await expect(importQueue(await fixture.project())).rejects.toMatchObject({
      code: 'patch-failed',
    });
    await expect(reExport(await fixture.project(), { all: true })).rejects.toMatchObject({
      code: 'session-active',
    });
  });
});

describe('exportPatch', () => {
  it('captures named unowned edits, tracked and untracked, as a new patch at the end', async () => {
    const fixture = await overlapping();
    await fixture.edit({
      [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n',
      'browser/modules/Mine.sys.mjs': 'export const mine = 1;\n',
    });
    await fixture.pin('141.0esr');
    const project = await fixture.project();
    const result = await exportPatch(project, {
      paths: ['browser/modules'],
      name: 'infra-mine',
      description: 'Mine',
      tier: 'branding',
    });
    expect(result.files).toEqual(['browser/modules/Mine.sys.mjs', MOZBUILD]);
    expect(result.patch).toMatchObject({
      filename: '006-infra-mine.patch',
      description: 'Mine',
      tier: 'branding',
      firefox: { version: '141.0esr' },
    });
    await expectReproduced(fixture);
    await fixture.resetEngine();
    await importQueue(project);
    expect(await fixture.read('browser/modules/Mine.sys.mjs')).toBe('export const mine = 1;\n');
  });

  it('leaves owned files under a directory to re-export, and refuses a named owned file', async () => {
    const fixture = await overlapping();
    await fixture.edit({
      [PANEL]: lines(30, (copy) => (copy[0] = 'edited')),
      'browser/components/panel/extra.mjs': '// extra\n',
    });
    const project = await fixture.project();
    await expect(exportPatch(project, { paths: [PANEL], name: 'ui-extra' })).rejects.toMatchObject({
      code: 'export-owned',
      hint: expect.stringContaining('re-export') as string,
    });
    const result = await exportPatch(project, {
      paths: ['browser/components/panel'],
      name: 'ui-extra',
    });
    expect(result.files).toEqual(['browser/components/panel/extra.mjs']);
  });

  it('refuses a path without an unowned edit, a clean engine, and a bad or taken name', async () => {
    const fixture = await overlapping();
    const project = await fixture.project();
    await expect(exportPatch(project, { all: true, name: 'ui-none' })).rejects.toMatchObject({
      code: 'export-nothing',
    });
    await fixture.edit({ 'browser/new.js': '// new\n' });
    await expect(
      exportPatch(project, { paths: ['browser/new.js', MOZBUILD], name: 'ui-new' })
    ).rejects.toMatchObject({
      code: 'export-nothing',
      message: expect.stringContaining(MOZBUILD) as string,
    });
    await expect(exportPatch(project, { all: true, name: 'UI New' })).rejects.toMatchObject({
      code: 'patch-name-invalid',
    });
    await expect(exportPatch(project, { all: true, name: 'ui-title' })).rejects.toMatchObject({
      code: 'patch-exists',
    });
  });

  it('places the patch before another, moving the run above it', async () => {
    const fixture = await overlapping();
    await fixture.edit({ 'browser/new.js': '// new\n' });
    const project = await fixture.project();
    const result = await exportPatch(project, { all: true, name: 'ui-new', before: 'ui-cleanup' });
    expect(result.patch.filename).toBe('003-ui-new.patch');
    expect((await loadQueue(project)).patches.map((patch) => patch.filename)).toEqual([
      '001-ui-panel.patch',
      '002-branding-icon.patch',
      '003-ui-new.patch',
      '004-ui-cleanup.patch',
      '005-ui-title.patch',
      '006-ui-panel-more.patch',
    ]);
  });

  it('skips a retired order by default, and takes it over when asked for it', async () => {
    const fixture = await overlapping();
    const project = await fixture.project();
    await retirePatch(project, 'ui-panel-more', 'merged');
    await fixture.edit({ 'browser/new.js': '// new\n', 'browser/other.js': '// other\n' });
    const first = await exportPatch(project, { paths: ['browser/new.js'], name: 'ui-new' });
    expect(first.patch.order).toBe(6);
    const second = await exportPatch(project, {
      paths: ['browser/other.js'],
      name: 'ui-other',
      order: 5,
    });
    expect(second.patch.order).toBe(5);
    expect((await loadQueue(project)).retired).toEqual([]);
  });

  it('allocates inside the category range and refuses an order the policy forbids', async () => {
    const fixture = await createPatchProject(dir());
    await writeTree(fixture.root, {
      'fireforge.json': JSON.stringify({
        ...MINIMAL_CONFIG,
        patchPolicy: {
          ranges: [
            { from: 1, to: 99, category: 'branding' },
            { from: 100, to: 199, category: 'ui' },
          ],
          reservedRanges: [{ from: 900, to: 999, allowed: [] }],
        },
      }),
    });
    await fixture.edit({ 'browser/a.js': 'a\n', 'browser/b.js': 'b\n', 'browser/c.js': 'c\n' });
    const project = await fixture.project();
    const first = await exportPatch(project, { paths: ['browser/a.js'], name: 'ui-a' });
    expect(first.patch.order).toBe(100);
    await expect(
      exportPatch(project, { paths: ['browser/b.js'], name: 'ui-b', order: 5 })
    ).rejects.toMatchObject({ code: 'queue-policy' });
    await expect(
      exportPatch(project, { paths: ['browser/b.js'], name: 'ui-b', order: 950 })
    ).rejects.toMatchObject({
      code: 'queue-policy',
      message: expect.stringContaining('reserved') as string,
    });
    await expect(
      exportPatch(project, { paths: ['browser/c.js'], name: 'infra-c' })
    ).rejects.toMatchObject({ code: 'queue-category-unknown' });
  });

  it('on a dry run writes nothing and returns the would-be queue as owned changes', async () => {
    const fixture = await overlapping();
    await fixture.edit({ 'browser/new.js': '// new\n' });
    const before = await readTree(fixture.patches);
    const result = await exportPatch(await fixture.project(), {
      all: true,
      name: 'ui-new',
      dryRun: true,
    });
    expect(await readTree(fixture.patches)).toEqual(before);
    expect(result.patch.filename).toBe('006-ui-new.patch');
    expect(result.changes?.inGroup('006-ui-new.patch').map((change) => change.path)).toEqual([
      'browser/new.js',
    ]);
    expect((await git(fixture.engine, ['status', '--porcelain'])).trim()).not.toBe('');
  });
});

describe('the queue as owned changes', () => {
  it('hands lint staged dependencies as a list of { file, creates }', async () => {
    const fixture = await overlapping();
    const project = await fixture.project();
    await mutateQueue(project, 'test', (draft) => {
      const row = draft.patches[0];
      if (row !== undefined) row.stagedDependencies = [{ file: PANEL, creates: 'later.mjs' }];
    });
    const changes = await queueChanges(project);
    expect(changes.group('001-ui-panel.patch')?.meta['stagedDependencies']).toEqual([
      { file: PANEL, creates: 'later.mjs' },
    ]);
  });
});
