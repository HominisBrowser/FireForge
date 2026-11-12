// SPDX-License-Identifier: EUPL-1.2
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resetShutdown, runShutdown } from '../kernel/signals.js';
import { createPatchProject, type PatchFixture } from '../testing/patch-project.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { mutateQueue, readQueue, writeQueue } from './index.js';
import { loadQueue, resolvePatch, selectPatches } from './queue.js';

const dir = useTempDir();
const STAMP = { product: 'firefox-esr' as const, version: '140.9.0esr' };
const BODY = (path: string): string =>
  `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+x\n`;

async function threePatches(): Promise<PatchFixture> {
  const fixture = await createPatchProject(dir());
  await fixture.addPatch('ui-sidebar', { 'browser/sidebar.js': '// sidebar\n' });
  await fixture.addPatch('infra-ci', { 'browser/ci.js': '// ci\n' }, { order: 5 });
  await fixture.addPatch('branding-sidebar', { 'browser/branding.js': '// b\n' }, { order: 10 });
  return fixture;
}

async function files(path: string): Promise<string[]> {
  return (await readdir(path)).sort();
}

describe('readQueue', () => {
  it('reads a missing queue as empty, and refuses patch files without a manifest', async () => {
    expect((await readQueue(join(dir(), 'patches'))).patches).toEqual([]);
    await writeTree(dir(), { 'patches/001-ui-a.patch': BODY('a') });
    await expect(readQueue(join(dir(), 'patches'))).rejects.toMatchObject({
      code: 'queue-manifest-missing',
    });
  });

  it('names every listed patch file that is missing', async () => {
    const fixture = await threePatches();
    const { rm } = await import('node:fs/promises');
    await rm(join(fixture.patches, '005-infra-ci.patch'));
    await expect(readQueue(fixture.patches)).rejects.toMatchObject({
      code: 'queue-patch-missing',
      message: expect.stringContaining('005-infra-ci.patch') as string,
    });
  });

  it('reads a version-1 queue and writes the current format on the next change', async () => {
    const fixture = await createPatchProject(dir());
    await writeTree(fixture.patches, {
      'patches.json': JSON.stringify({
        version: 1,
        patches: [
          {
            filename: '1-ui-a.patch',
            order: 1,
            category: 'ui',
            name: 'a',
            description: '',
            createdAt: 'x',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['stale.js'],
          },
        ],
      }),
      '1-ui-a.patch': BODY('a.js'),
    });
    const project = await fixture.project();
    const queue = await loadQueue(project);
    expect(queue.patches.map((patch) => [patch.name, patch.category, patch.files])).toEqual([
      ['ui-a', 'ui', ['a.js']],
    ]);
    await mutateQueue(project, 'the description', (draft) => {
      const [row] = draft.patches;
      if (row !== undefined) row.description = 'converted';
    });
    expect(await files(fixture.patches)).toEqual(['001-ui-a.patch', 'patches.json']);
    expect(await readFile(join(fixture.patches, '001-ui-a.patch'), 'utf8')).toBe(BODY('a.js'));
    const manifest = JSON.parse(await readFile(join(fixture.patches, 'patches.json'), 'utf8')) as {
      version: number;
      patches: unknown[];
    };
    expect(manifest.version).toBe(2);
    expect(manifest.patches).toEqual([{ order: 1, name: 'ui-a', description: 'converted' }]);
  });
});

describe('mutateQueue', () => {
  it('renames, reorders and deletes by editing the draft, and the files follow', async () => {
    const fixture = await threePatches();
    const project = await fixture.project();
    const before = await loadQueue(project);
    await mutateQueue(project, 'test', (draft) => {
      const [sidebar, ci, branding] = draft.patches;
      if (sidebar === undefined || ci === undefined || branding === undefined)
        throw new Error('setup');
      sidebar.name = 'ui-side-panel';
      ci.order = 20;
      draft.patches = [sidebar, ci];
    });
    expect(await files(fixture.patches)).toEqual([
      '001-ui-side-panel.patch',
      '020-infra-ci.patch',
      'patches.json',
    ]);
    const after = await loadQueue(project);
    expect(after.patches.map((patch) => patch.filename)).toEqual([
      '001-ui-side-panel.patch',
      '020-infra-ci.patch',
    ]);
    expect(after.patches[0]?.body).toEqual(before.patches[0]?.body);
    expect(after.digest).not.toBe(before.digest);
  });

  it('puts every file back when a write fails half-way', async () => {
    const fixture = await threePatches();
    const project = await fixture.project();
    const before = await files(fixture.patches);
    const sidebar = await readFile(join(fixture.patches, '001-ui-sidebar.patch'));
    // A directory where the renamed patch's file has to go makes that write fail.
    await mkdir(join(fixture.patches, '005-infra-pipeline.patch'));
    await expect(
      mutateQueue(project, 'the change', (draft) => {
        const [first, second] = draft.patches;
        if (first === undefined || second === undefined) throw new Error('setup');
        first.body = Buffer.from(BODY('browser/other.js'));
        second.name = 'infra-pipeline';
      })
    ).rejects.toThrow();
    expect(await files(fixture.patches)).toEqual([...before, '005-infra-pipeline.patch'].sort());
    expect(await readFile(join(fixture.patches, '001-ui-sidebar.patch'))).toEqual(sidebar);
    expect((await loadQueue(project)).patches.map((patch) => patch.name)).toEqual([
      'ui-sidebar',
      'infra-ci',
      'branding-sidebar',
    ]);
  });

  it('writes nothing once an interrupt has arrived', async () => {
    const fixture = await threePatches();
    const project = await fixture.project();
    const before = await readFile(join(fixture.patches, 'patches.json'), 'utf8');
    await runShutdown('SIGINT');
    try {
      await expect(
        mutateQueue(project, 'the change', (draft) => {
          draft.patches = draft.patches.slice(1);
        })
      ).rejects.toMatchObject({ code: 'interrupted' });
    } finally {
      resetShutdown();
    }
    expect(await readFile(join(fixture.patches, 'patches.json'), 'utf8')).toBe(before);
    expect(await files(fixture.patches)).toHaveLength(4);
  });

  it('refuses an inconsistent draft and leaves the queue as it was', async () => {
    const fixture = await threePatches();
    const project = await fixture.project();
    const manifest = await readFile(join(fixture.patches, 'patches.json'), 'utf8');
    await expect(
      mutateQueue(project, 'test', (draft) => {
        for (const patch of draft.patches) patch.order = 3;
      })
    ).rejects.toMatchObject({ code: 'queue-invalid' });
    await expect(
      mutateQueue(project, 'test', (draft) => {
        const first = draft.patches[0];
        if (first !== undefined) first.name = 'Not A Name';
      })
    ).rejects.toMatchObject({ code: 'queue-invalid' });
    expect(await readFile(join(fixture.patches, 'patches.json'), 'utf8')).toBe(manifest);
  });

  it('rolls every file back when a write fails part way', async () => {
    const fixture = await threePatches();
    const project = await fixture.project();
    const manifest = await readFile(join(fixture.patches, 'patches.json'), 'utf8');
    const listing = await files(fixture.patches);
    await mkdir(join(fixture.patches, '030-ui-blocked.patch'));
    await expect(
      mutateQueue(project, 'test', (draft) => {
        const first = draft.patches[0];
        if (first !== undefined) first.body = Buffer.from(BODY('changed.js'));
        draft.patches.push({
          order: 30,
          name: 'ui-blocked',
          description: '',
          firefox: STAMP,
          body: Buffer.from(BODY('b')),
        });
      })
    ).rejects.toThrow();
    expect(await readFile(join(fixture.patches, 'patches.json'), 'utf8')).toBe(manifest);
    expect(await readFile(join(fixture.patches, '001-ui-sidebar.patch'), 'utf8')).toContain(
      'sidebar'
    );
    expect(await files(fixture.patches)).toEqual([...listing, '030-ui-blocked.patch'].sort());
  });
});

describe('resolvePatch', () => {
  it.each([
    ['5', '005-infra-ci.patch'],
    ['005', '005-infra-ci.patch'],
    ['005-infra-ci.patch', '005-infra-ci.patch'],
    ['005-infra-ci', '005-infra-ci.patch'],
    ['infra-ci', '005-infra-ci.patch'],
    ['ci', '005-infra-ci.patch'],
    ['ui-sidebar', '001-ui-sidebar.patch'],
  ])('finds %s', async (identifier, filename) => {
    const queue = await readQueue((await threePatches()).patches);
    expect(resolvePatch(queue, identifier).filename).toBe(filename);
  });

  it('lists the candidates of an ambiguous name and suggests the nearest unknown one', async () => {
    const queue = await readQueue((await threePatches()).patches);
    expect(() => resolvePatch(queue, 'sidebar')).toThrow(
      /001-ui-sidebar\.patch, 010-branding-sidebar\.patch/
    );
    expect(() => resolvePatch(queue, 'infra-cj')).toThrow(
      expect.objectContaining({ hint: 'Did you mean "infra-ci"?' })
    );
    expect(selectPatches(queue, ['10', 'infra-ci', '5']).map((patch) => patch.order)).toEqual([
      5, 10,
    ]);
  });
});

describe('writeQueue', () => {
  it('writes a complete queue into an empty directory and refuses a non-empty one', async () => {
    const target = join(dir(), 'out');
    const queue = await writeQueue(target, {
      source: { snapshot: 'deadbeef' },
      patches: [
        {
          order: 2,
          name: 'ui-b',
          description: 'B',
          firefox: STAMP,
          body: Buffer.from(BODY('b.js')),
        },
        {
          order: 1,
          name: 'ui-a',
          description: 'A',
          firefox: STAMP,
          body: Buffer.from(BODY('a.js')),
        },
      ],
    });
    expect(queue.patches.map((patch) => [patch.filename, patch.files])).toEqual([
      ['001-ui-a.patch', ['a.js']],
      ['002-ui-b.patch', ['b.js']],
    ]);
    expect(queue.source).toEqual({ snapshot: 'deadbeef' });
    await writeFile(join(dir(), 'other'), '');
    await expect(writeQueue(dir(), { patches: [] })).rejects.toMatchObject({
      code: 'queue-target-not-empty',
    });
  });
});
