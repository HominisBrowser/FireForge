// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MINIMAL_CONFIG } from '../testing/config.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { readTree, useTempDir, writeTree } from '../testing/temp.js';
import {
  compactQueue,
  deletePatch,
  exportPatch,
  moveFiles,
  queueStatus,
  renamePatch,
  reorderPatch,
  replayQueue,
  retirePatch,
  setPatchMeta,
  splitPatch,
  verifyQueue,
} from './index.js';
import { loadQueue } from './queue.js';

const dir = useTempDir();
const A = 'browser/components/a/a.mjs';
const A_CSS = 'browser/components/a/a.css';
const B = 'browser/components/b/b.mjs';
const C = 'browser/components/c/c.mjs';
const BROWSER = 'browser/base/content/browser.js';

const lines = (count: number, edit: (copy: string[]) => void = () => undefined): string => {
  const copy = Array.from({ length: count }, (_, index) => `line ${index + 1}`);
  edit(copy);
  return `${copy.join('\n')}\n`;
};

/** Four patches; the last changes a file the first creates. */
async function queue(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-a', { [A]: lines(20), [A_CSS]: '.a {}\n' });
  await fixture.addPatch('ui-b', { [B]: 'export const b = 1;\n' });
  await fixture.addPatch('ui-c', { [C]: 'export const c = 1;\n' });
  await fixture.addPatch('ui-a-more', { [A]: lines(20, (copy) => (copy[15] = 'line 16 more')) });
  return fixture;
}

async function filenames(fixture: PatchFixture): Promise<string[]> {
  return (await loadQueue(await fixture.project())).patches.map((patch) => patch.filename);
}

/** The full tree the stored queue produces on the engine's HEAD. */
async function produced(fixture: PatchFixture): Promise<string> {
  return replayQueue(fixture.engine, 'HEAD', fixture.patches);
}

async function expectSound(fixture: PatchFixture): Promise<void> {
  const project = await fixture.project();
  expect((await verifyQueue(project)).problems).toEqual([]);
  expect((await queueStatus(project)).paths.filter((path) => path.state !== 'clean')).toEqual([]);
}

async function withPolicy(fixture: PatchFixture, policy: Record<string, unknown>): Promise<void> {
  await writeTree(fixture.root, {
    'fireforge.json': JSON.stringify({ ...MINIMAL_CONFIG, patchPolicy: policy }),
  });
}

describe('renamePatch', () => {
  it('renames the row and its file, keeping order and body', async () => {
    const fixture = await queue();
    const body = await readFile(join(fixture.patches, '002-ui-b.patch'));
    const edit = await renamePatch(await fixture.project(), 'ui-b', 'ui-bee');
    expect(edit.renamed).toEqual([{ from: '002-ui-b.patch', to: '002-ui-bee.patch' }]);
    expect(await readFile(join(fixture.patches, '002-ui-bee.patch'))).toEqual(body);
    expect(await readdir(fixture.patches)).not.toContain('002-ui-b.patch');
  });

  it('refuses an invalid or taken name and reports a same-name rename as no change', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await expect(renamePatch(project, 'ui-b', 'ui-c')).rejects.toMatchObject({
      code: 'patch-exists',
    });
    await expect(renamePatch(project, 'ui-b', 'UI B')).rejects.toMatchObject({
      code: 'patch-name-invalid',
    });
    await expect(renamePatch(project, 'nope', 'ui-x')).rejects.toMatchObject({
      code: 'patch-not-found',
    });
    expect(await renamePatch(project, 'ui-b', 'ui-b')).toEqual({
      renamed: [],
      created: [],
      removed: [],
      rewritten: [],
    });
  });
});

describe('reorderPatch', () => {
  it('moves the run above an occupied order up by one', async () => {
    const fixture = await queue();
    const tree = await produced(fixture);
    await reorderPatch(await fixture.project(), 'ui-c', { order: 1 });
    expect(await filenames(fixture)).toEqual([
      '001-ui-c.patch',
      '002-ui-a.patch',
      '003-ui-b.patch',
      '004-ui-a-more.patch',
    ]);
    expect(await produced(fixture)).toBe(tree);
    await expectSound(fixture);
  });

  it('keeps gaps outside the run it moves', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-a', { [A]: 'a\n' }, { order: 1 });
    await fixture.addPatch('ui-b', { [B]: 'b\n' }, { order: 3 });
    await fixture.addPatch('ui-c', { [C]: 'c\n' }, { order: 7 });
    await reorderPatch(await fixture.project(), '7', { order: 3 });
    expect(await filenames(fixture)).toEqual([
      '001-ui-a.patch',
      '003-ui-c.patch',
      '004-ui-b.patch',
    ]);
  });

  it('places before and after another patch', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await reorderPatch(project, 'ui-c', { before: 'ui-b' });
    expect(await filenames(fixture)).toEqual([
      '001-ui-a.patch',
      '002-ui-c.patch',
      '003-ui-b.patch',
      '004-ui-a-more.patch',
    ]);
    await reorderPatch(project, 'ui-a', { after: 'ui-b' });
    expect(await filenames(fixture)).toEqual([
      '002-ui-c.patch',
      '003-ui-b.patch',
      '004-ui-a.patch',
      '005-ui-a-more.patch',
    ]);
    await expect(reorderPatch(project, 'ui-a', { after: 'ui-a' })).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  it('refuses to put a patch before the one whose file it changes, writing nothing', async () => {
    const fixture = await queue();
    const before = await readTree(fixture.patches);
    await expect(
      reorderPatch(await fixture.project(), 'ui-a-more', { before: 'ui-a' })
    ).rejects.toMatchObject({ code: 'queue-operation-conflict' });
    expect(await readTree(fixture.patches)).toEqual(before);
  });

  it('refuses an order the policy reserves for named exceptions', async () => {
    const fixture = await queue();
    await withPolicy(fixture, {
      ranges: [{ from: 1, to: 99, category: 'ui' }],
      reservedRanges: [{ from: 900, to: 999, allowed: [{ filename: '900-ui-c.patch', adr: 'x' }] }],
    });
    const project = await fixture.project();
    await expect(reorderPatch(project, 'ui-b', { order: 950 })).rejects.toMatchObject({
      code: 'queue-policy',
    });
    await reorderPatch(project, 'ui-c', { order: 900 });
    expect(await filenames(fixture)).toContain('900-ui-c.patch');
  });
});

describe('splitPatch', () => {
  it('moves files into a new patch right after the source, the result unchanged', async () => {
    const fixture = await queue();
    const tree = await produced(fixture);
    const project = await fixture.project();
    const edit = await splitPatch(project, 'ui-a', {
      files: [A_CSS],
      name: 'ui-a-style',
      description: 'Style',
    });
    expect(edit.created).toEqual(['002-ui-a-style.patch']);
    expect(edit.rewritten).toEqual(['001-ui-a.patch']);
    const patches = (await loadQueue(project)).patches;
    expect(patches.map((patch) => [patch.filename, patch.files])).toEqual([
      ['001-ui-a.patch', [A]],
      ['002-ui-a-style.patch', [A_CSS]],
      ['003-ui-b.patch', [B]],
      ['004-ui-c.patch', [C]],
      ['005-ui-a-more.patch', [A]],
    ]);
    expect(patches[1]?.description).toBe('Style');
    expect(await produced(fixture)).toBe(tree);
    await expectSound(fixture);
  });

  it('takes staged dependencies declared on the moved files along', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await setPatchMeta(project, 'ui-a', {
      stagedDependencies: {
        add: [
          { file: A_CSS, creates: 'later.css' },
          { file: A, creates: 'later.mjs' },
        ],
      },
    });
    await splitPatch(project, 'ui-a', { files: [A_CSS], name: 'ui-a-style' });
    const patches = (await loadQueue(project)).patches;
    expect(patches[0]?.stagedDependencies).toEqual([{ file: A, creates: 'later.mjs' }]);
    expect(patches[1]?.stagedDependencies).toEqual([{ file: A_CSS, creates: 'later.css' }]);
  });

  it('refuses to move every file, a file the patch does not touch, and a placement that breaks the result', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await expect(
      splitPatch(project, 'ui-a', { files: ['browser/components/a'], name: 'ui-x' })
    ).rejects.toMatchObject({ code: 'patch-split-all' });
    await expect(splitPatch(project, 'ui-a', { files: [B], name: 'ui-x' })).rejects.toMatchObject({
      code: 'patch-file-not-owned',
    });
    await expect(
      splitPatch(project, 'ui-a', { files: [A], name: 'ui-x', placement: { order: 10 } })
    ).rejects.toMatchObject({ code: 'queue-operation-conflict' });
    const before = await readTree(fixture.patches);
    await mkdir(join(fixture.patches, '002-ui-blocked.patch'));
    await expect(
      splitPatch(project, 'ui-a', { files: [A_CSS], name: 'ui-blocked' })
    ).rejects.toThrow();
    expect(await readTree(fixture.patches)).toEqual(before);
  });
});

describe('moveFiles', () => {
  it('moves a file into a later patch and removes a source left empty', async () => {
    const fixture = await queue();
    const tree = await produced(fixture);
    const project = await fixture.project();
    const edit = await moveFiles(project, 'ui-b', 'ui-c', [B]);
    expect(edit.removed).toEqual(['002-ui-b.patch']);
    expect(edit.rewritten).toEqual(['003-ui-c.patch']);
    expect(
      (await loadQueue(project)).patches.find((patch) => patch.name === 'ui-c')?.files
    ).toEqual([B, C]);
    expect(await produced(fixture)).toBe(tree);
    await expectSound(fixture);
  });

  it('combines the change with the one the target already makes to the file', async () => {
    const fixture = await queue();
    const tree = await produced(fixture);
    const project = await fixture.project();
    await moveFiles(project, 'ui-a', 'ui-a-more', [A]);
    const patches = (await loadQueue(project)).patches;
    expect(patches.map((patch) => [patch.name, patch.files])).toEqual([
      ['ui-a', [A_CSS]],
      ['ui-b', [B]],
      ['ui-c', [C]],
      ['ui-a-more', [A]],
    ]);
    const body = patches[3]?.body.toString('utf8') ?? '';
    expect(body).toContain('new file mode');
    expect(body).toContain('+line 16 more');
    expect(await produced(fixture)).toBe(tree);
    await expectSound(fixture);
  });

  it('moves a file into an earlier patch when the change fits there', async () => {
    const fixture = await queue();
    const tree = await produced(fixture);
    await moveFiles(await fixture.project(), 'ui-c', 'ui-a', [C]);
    expect(await produced(fixture)).toBe(tree);
    await expectSound(fixture);
  });
});

describe('deletePatch and retirePatch', () => {
  it('deletes a patch, leaving the engine and naming the files nothing owns now', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    const removal = await deletePatch(project, 'ui-b');
    expect(removal).toMatchObject({ removed: ['002-ui-b.patch'], files: [B] });
    expect(await fixture.read(B)).toBe('export const b = 1;\n');
    const status = await queueStatus(project);
    expect(status.paths.find((path) => path.path === B)?.state).toBe('unmanaged');
  });

  it('refuses to remove a patch a later one needs', async () => {
    const fixture = await queue();
    await expect(deletePatch(await fixture.project(), 'ui-a')).rejects.toMatchObject({
      code: 'patch-has-dependents',
      message: expect.stringContaining('ui-a-more') as string,
    });
    await expect(retirePatch(await fixture.project(), 'ui-a')).rejects.toMatchObject({
      code: 'patch-has-dependents',
    });
  });

  it('retires a patch into a slot the gap check counts as occupied', async () => {
    const fixture = await queue();
    await withPolicy(fixture, { ranges: [{ from: 1, to: 99, category: 'ui' }], allowGaps: false });
    const project = await fixture.project();
    await expect(deletePatch(project, 'ui-b')).rejects.toMatchObject({ code: 'queue-policy' });
    await retirePatch(project, 'ui-b', 'merged into ui-c');
    const stored = await loadQueue(project);
    expect(stored.retired).toEqual([{ order: 2, name: 'ui-b', reason: 'merged into ui-c' }]);
    expect((await verifyQueue(project)).problems).toEqual([]);
    await fixture.edit({ 'browser/new.js': '// new\n' });
    expect((await exportPatch(project, { all: true, name: 'ui-new' })).patch.order).toBe(5);
  });
});

describe('compactQueue', () => {
  it('numbers the queue from 1 without a policy, dropping retired slots', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-a', { [A]: 'a\n' }, { order: 3 });
    await fixture.addPatch('ui-b', { [B]: 'b\n' }, { order: 7 });
    await fixture.addPatch('ui-c', { [C]: 'c\n' }, { order: 9 });
    const project = await fixture.project();
    await retirePatch(project, 'ui-b');
    const edit = await compactQueue(project);
    expect(edit.renamed).toEqual([
      { from: '003-ui-a.patch', to: '001-ui-a.patch' },
      { from: '009-ui-c.patch', to: '002-ui-c.patch' },
    ]);
    expect((await loadQueue(project)).retired).toEqual([]);
  });

  it('numbers each category range from its first patch', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('branding-a', { [A]: 'a\n' }, { order: 5 });
    await fixture.addPatch('branding-b', { [B]: 'b\n' }, { order: 9 });
    await fixture.addPatch('ui-c', { [C]: 'c\n' }, { order: 120 });
    await fixture.addPatch('ui-d', { [BROWSER]: 'd\n' }, { order: 150 });
    await withPolicy(fixture, {
      ranges: [
        { from: 1, to: 99, category: 'branding' },
        { from: 100, to: 199, category: 'ui' },
      ],
    });
    await compactQueue(await fixture.project());
    expect(await filenames(fixture)).toEqual([
      '005-branding-a.patch',
      '006-branding-b.patch',
      '120-ui-c.patch',
      '121-ui-d.patch',
    ]);
  });
});

describe('setPatchMeta', () => {
  it('edits description and tier, and reports an edit that changes nothing', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    expect(
      await setPatchMeta(project, 'ui-b', { description: 'Bee', tier: 'branding' })
    ).toMatchObject({
      patch: '002-ui-b.patch',
      changed: true,
      entry: { description: 'Bee', tier: 'branding' },
    });
    expect(await setPatchMeta(project, 'ui-b', { tier: 'branding' })).toMatchObject({
      changed: false,
    });
    await setPatchMeta(project, 'ui-b', { tier: null });
    expect((await loadQueue(project)).patches[1]?.tier).toBeUndefined();
  });

  it('adds, replaces and removes lint waivers, ceilings included', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await setPatchMeta(project, 'ui-b', { lintIgnore: { add: ['jsdoc', 'file-too-large'] } });
    await setPatchMeta(project, 'ui-b', {
      lintIgnore: { add: [{ rule: 'file-too-large', max: 900, reason: 'tracked' }] },
    });
    expect((await loadQueue(project)).patches[1]?.lintIgnore).toEqual([
      'jsdoc',
      { rule: 'file-too-large', max: 900, reason: 'tracked' },
    ]);
    await expect(
      setPatchMeta(project, 'ui-b', { lintIgnore: { remove: ['raw-color'] } })
    ).rejects.toMatchObject({
      code: 'patch-meta-absent',
      hint: expect.stringContaining('jsdoc') as string,
    });
    await setPatchMeta(project, 'ui-b', { lintIgnore: { remove: ['jsdoc', 'file-too-large'] } });
    const manifest = await readFile(join(fixture.patches, 'patches.json'), 'utf8');
    expect(manifest).not.toContain('lintIgnore');
  });

  it('adds and removes staged dependencies, replacing an equal one', async () => {
    const fixture = await queue();
    const project = await fixture.project();
    await setPatchMeta(project, 'ui-a', {
      stagedDependencies: { add: [{ file: A, creates: C }] },
    });
    await setPatchMeta(project, 'ui-a', {
      stagedDependencies: { add: [{ file: A, creates: C, reason: 'wired in ui-c' }] },
    });
    expect((await loadQueue(project)).patches[0]?.stagedDependencies).toEqual([
      { file: A, creates: C, reason: 'wired in ui-c' },
    ]);
    await expect(
      setPatchMeta(project, 'ui-a', { stagedDependencies: { remove: [{ file: A, creates: B }] } })
    ).rejects.toMatchObject({ code: 'patch-meta-absent' });
    await setPatchMeta(project, 'ui-a', {
      stagedDependencies: { remove: [{ file: A, creates: C }] },
    });
    expect((await loadQueue(project)).patches[0]?.stagedDependencies).toBeUndefined();
  });

  it('refuses a description the policy requires to be empty-free', async () => {
    const fixture = await queue();
    await setPatchMeta(await fixture.project(), 'ui-b', { description: 'Bee' });
    await withPolicy(fixture, {
      ranges: [{ from: 1, to: 99, category: 'ui' }],
      requireDescription: true,
    });
    await expect(
      setPatchMeta(await fixture.project(), 'ui-b', { description: '' })
    ).rejects.toMatchObject({ code: 'queue-policy' });
  });
});
