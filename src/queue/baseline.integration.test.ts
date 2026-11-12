// SPDX-License-Identifier: EUPL-1.2
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir } from '../testing/temp.js';
import { projectQueue } from './baseline.js';
import {
  engineChanges,
  importQueue,
  mutateQueue,
  queueChanges,
  queueStatus,
  verifyQueue,
} from './index.js';
import { loadQueue } from './queue.js';

const dir = useTempDir();
const BROWSER = 'browser/base/content/browser.js';
const SERVICE = 'toolkit/components/example/service.sys.mjs';
const MOZBUILD = 'browser/modules/moz.build';
const PNG = 'browser/branding/unofficial/default16.png';
const NEW = 'browser/new.js';

async function imported(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-title', { [BROWSER]: 'export const browserTitle = "patched";\n' });
  await fixture.addPatch('ui-new', { [NEW]: 'export const fresh = 1;\n' }, { tier: 'branding' });
  await fixture.addPatch(
    'ui-cleanup',
    { [SERVICE]: null },
    { lintIgnore: ['jsdoc', { rule: 'large-patch-files', max: 3, reason: 'one unit' }] }
  );
  await fixture.addPatch('infra-dirs', { [MOZBUILD]: 'DIRS += ["newtab"]\nDIRS += ["mine"]\n' });
  await fixture.addPatch('branding-icon', { [PNG]: Buffer.from([0, 1, 2, 3, 0]) });
  await fixture.addPatch('ui-new-more', { [NEW]: 'export const fresh = 2;\n' });
  return fixture;
}

describe('queueStatus', () => {
  it('classifies every queue path and every other changed path', async () => {
    const fixture = await imported();
    await fixture.edit({
      [BROWSER]: 'export const browserTitle = "edited";\n',
      [NEW]: null,
      [MOZBUILD]: null,
      'browser/moz.configure': 'changed\n',
      'browser/untracked.js': '// mine\n',
    });
    const status = await queueStatus(await fixture.project());
    expect(status.patches).toBe(6);
    expect(status.failure).toBeUndefined();
    expect(status.paths.map((path) => [path.path, path.state, path.owners])).toEqual([
      [BROWSER, 'modified', ['001-ui-title.patch']],
      [PNG, 'clean', ['005-branding-icon.patch']],
      [MOZBUILD, 'missing', ['004-infra-dirs.patch']],
      ['browser/moz.configure', 'unmanaged', []],
      [NEW, 'unapplied', ['002-ui-new.patch', '006-ui-new-more.patch']],
      ['browser/untracked.js', 'unmanaged', []],
      [SERVICE, 'clean', ['003-ui-cleanup.patch']],
    ]);
  });

  it('compares binary files by content, whatever bytes they hold', async () => {
    const fixture = await imported();
    const project = await fixture.project();
    const state = async (): Promise<string | undefined> =>
      (await queueStatus(project)).paths.find((path) => path.path === PNG)?.state;
    expect(await state()).toBe('clean');
    await fixture.edit({ [PNG]: Buffer.from([0, 1, 2, 3, 1]) });
    expect(await state()).toBe('modified');
    await fixture.edit({ [PNG]: 'no NUL byte here' });
    expect(await state()).toBe('modified');
    await fixture.edit({ [PNG]: Buffer.from([0, 1, 2, 3, 0]) });
    expect(await state()).toBe('clean');
  });

  it('reports the patch the queue stops applying at', async () => {
    const fixture = await imported();
    await fixture.upstream({ [MOZBUILD]: 'DIRS += ["upstream"]\n' });
    const status = await queueStatus(await fixture.project());
    expect(status.failure).toMatchObject({ patch: '004-infra-dirs.patch' });
  });
});

describe('projectQueue', () => {
  it('is cached by queue digest and engine commit', async () => {
    const fixture = await imported();
    const project = await fixture.project();
    const first = await projectQueue(project, await loadQueue(project));
    const cache = join(fixture.root, '.fireforge/queue-projection.json');
    const stamp = await readFile(cache, 'utf8');
    const second = await projectQueue(project, await loadQueue(project));
    expect(second.steps).toEqual(first.steps);
    expect(await readFile(cache, 'utf8')).toBe(stamp);
    expect(first.history(NEW).map((entry) => entry.patch)).toEqual([
      undefined,
      '002-ui-new.patch',
      '006-ui-new-more.patch',
    ]);
    await mutateQueue(project, 'test', (draft) => {
      draft.patches = draft.patches.filter((patch) => patch.name !== 'ui-new-more');
    });
    const third = await projectQueue(project, await loadQueue(project));
    expect(third.digest).not.toBe(first.digest);
    expect(third.steps).toHaveLength(5);
  });
});

describe('queueChanges', () => {
  it('gives one group per patch and one step per patch per path', async () => {
    const fixture = await imported();
    const set = await queueChanges(await fixture.project());
    expect(set.groups.map((group) => group.id)).toEqual([
      '001-ui-title.patch',
      '002-ui-new.patch',
      '003-ui-cleanup.patch',
      '004-infra-dirs.patch',
      '005-branding-icon.patch',
      '006-ui-new-more.patch',
    ]);
    expect(set.group('002-ui-new.patch')).toMatchObject({
      tier: 'branding',
      meta: { name: 'ui-new', category: 'ui' },
    });
    expect(set.group('003-ui-cleanup.patch')).toMatchObject({
      lintIgnore: ['jsdoc', { rule: 'large-patch-files', max: 3 }],
    });
    expect(set.at(NEW).map((change) => [change.group, change.kind])).toEqual([
      ['002-ui-new.patch', 'create'],
      ['006-ui-new-more.patch', 'modify'],
    ]);
    const created = set.final(NEW);
    expect(created?.kind).toBe('create');
    if (created?.kind === 'create')
      expect(Buffer.from(await created.after()).toString()).toBe('export const fresh = 2;\n');
    expect(set.final(SERVICE)?.kind).toBe('delete');
    expect(set.final(PNG)?.binary).toBe(true);
    expect(set.final(BROWSER)?.binary).toBe(false);
    const step = set.inGroup('001-ui-title.patch')[0];
    expect(step === undefined ? '' : await set.diff?.(step)).toBe(
      await readFile(join(fixture.patches, '001-ui-title.patch'), 'utf8')
    );
    const net = set.final(NEW);
    expect(net === undefined ? '' : await set.diff?.(net)).toContain('+export const fresh = 2;');
  });

  it('refuses a queue that does not apply', async () => {
    const fixture = await imported();
    await fixture.upstream({ [MOZBUILD]: 'DIRS += ["upstream"]\n' });
    await expect(queueChanges(await fixture.project())).rejects.toMatchObject({
      code: 'queue-does-not-apply',
    });
  });
});

describe('engineChanges', () => {
  it('shows exported work under its first patch and unexported edits without a group', async () => {
    const fixture = await imported();
    await fixture.edit({
      [BROWSER]: 'export const browserTitle = "edited";\n',
      'browser/untracked.js': '// mine\n',
    });
    const set = await engineChanges(await fixture.project());
    expect(
      set.net().map((change) => [change.path, change.kind, change.group, change.meta['state']])
    ).toEqual([
      [BROWSER, 'modify', '001-ui-title.patch', 'modified'],
      [PNG, 'modify', '005-branding-icon.patch', 'clean'],
      [MOZBUILD, 'modify', '004-infra-dirs.patch', 'clean'],
      [NEW, 'create', '002-ui-new.patch', 'clean'],
      ['browser/untracked.js', 'create', undefined, 'unmanaged'],
      [SERVICE, 'delete', '003-ui-cleanup.patch', 'clean'],
    ]);
    expect(set.final(PNG)?.binary).toBe(true);
    const untracked = set.final('browser/untracked.js');
    expect(untracked === undefined ? '' : await set.diff?.(untracked)).toContain('+// mine');
  });
});

describe('verifyQueue', () => {
  it('passes a sound queue and names each kind of problem', async () => {
    const fixture = await imported();
    const project = await fixture.project();
    expect(await verifyQueue(project)).toEqual({ patches: 6, problems: [], replayed: true });

    await writeFile(join(fixture.patches, '099-ui-stray.patch'), '');
    await writeFile(
      join(fixture.patches, '006-ui-new-more.patch'),
      `diff --git a/${PNG} b/${PNG}\nindex 1111111..2222222 100644\nBinary files a/${PNG} and b/${PNG} differ\n`
    );
    const found = await verifyQueue(project);
    expect(found.problems.map((problem) => [problem.code, problem.patch])).toEqual([
      ['stray-patch-file', '099-ui-stray.patch'],
      ['binary-stub', '006-ui-new-more.patch'],
      ['does-not-apply', '006-ui-new-more.patch'],
    ]);

    await rm(join(fixture.patches, '001-ui-title.patch'));
    expect((await verifyQueue(project)).problems).toMatchObject([{ code: 'queue-patch-missing' }]);
  });

  it('flags a patch that creates a file upstream already has', async () => {
    const fixture = await createPatchProject(dir());
    await fixture.addPatch('ui-new', { [NEW]: 'mine\n' });
    await fixture.upstream({ [NEW]: 'upstream\n' });
    const project = await fixture.project();
    expect((await verifyQueue(project)).problems).toMatchObject([
      { code: 'replaces-upstream-file', patch: '001-ui-new.patch' },
    ]);
    await importQueue(project, { force: true });
    expect(await fixture.read(NEW)).toBe('mine\n');
  });
});
