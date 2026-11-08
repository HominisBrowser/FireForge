// SPDX-License-Identifier: EUPL-1.2
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { registrationSupplies } from '../../commands/verify-registration-supply.js';
import {
  createTempProject,
  initCommittedRepo,
  removeTempProject,
  runGit,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { getAllDiff } from '../git-diff.js';
import { classifyFiles } from '../status-classify.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeTempProject));
});
async function fixture(): Promise<{ root: string; engine: string; patches: string }> {
  const root = await createTempProject('ff-a09-status-');
  roots.push(root);
  await writeFireForgeConfig(root);
  const engine = join(root, 'engine'),
    patches = join(root, 'patches');
  await initCommittedRepo(engine, { 'base.txt': 'base\n', 'owned.txt': 'original\n' });
  await mkdir(patches);
  return { root, engine, patches };
}
async function install(patches: string, body: string, file: string): Promise<void> {
  await writeFile(join(patches, '001-ui-owned.patch'), body);
  await writeFile(
    join(patches, 'patches.json'),
    JSON.stringify({
      version: 1,
      patches: [
        {
          filename: '001-ui-owned.patch',
          order: 1,
          category: 'ui',
          name: 'owned',
          description: 'fixture',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: [file],
        },
      ],
    })
  );
}
it('requires recorded executable mode even when the live bytes match', async () => {
  const { engine, patches } = await fixture();
  await writeFile(join(engine, 'owned.txt'), 'modified\n');
  await install(patches, await getAllDiff(engine), 'owned.txt');
  const classify = (): ReturnType<typeof classifyFiles> =>
    classifyFiles([{ status: ' M', file: 'owned.txt' }], engine, patches, 'fixture', new Set());
  expect((await classify())[0]?.classification).toBe('patch-backed');
  await chmod(join(engine, 'owned.txt'), 0o755);
  expect((await classify())[0]?.classification).toBe('patch-owned-drift');
  await chmod(join(engine, 'owned.txt'), 0o644);
  await writeFile(join(engine, 'same-bytes.txt'), 'modified\n');
  await rm(join(engine, 'owned.txt'));
  await symlink('same-bytes.txt', join(engine, 'owned.txt'));
  expect((await classify())[0]?.classification).toBe('patch-owned-drift');
});
it('compares a symlink blob target without following its missing referent', async () => {
  const { engine, patches } = await fixture();
  await symlink('missing.txt', join(engine, 'link'));
  await install(patches, await getAllDiff(engine), 'link');
  expect(
    (
      await classifyFiles([{ status: '??', file: 'link' }], engine, patches, 'fixture', new Set())
    )[0]?.classification
  ).toBe('patch-backed');
});
it('uses a replayable owning binary section for Latin1 bytes that have no NUL', async () => {
  const { engine, patches } = await fixture(),
    file = 'latin1.bin';
  await writeFile(join(engine, '.gitattributes'), '*.bin binary\n');
  const bytes = Buffer.from([0xff, 0xe9, 0x0a]);
  await writeFile(join(engine, file), bytes);
  await install(patches, await getAllDiff(engine), file);
  expect(
    (await classifyFiles([{ status: '??', file }], engine, patches, 'fixture', new Set()))[0]
      ?.classification
  ).toBe('patch-backed');
  expect(await readFile(join(engine, file))).toEqual(bytes);
});
it('rejects engine-only untracked registration targets and deleted queue postimages', async () => {
  const { root, engine } = await fixture();
  await writeFile(join(engine, 'ephemeral.mjs'), 'not durable\n');
  const modify =
    'diff --git a/ephemeral.mjs b/ephemeral.mjs\n--- a/ephemeral.mjs\n+++ b/ephemeral.mjs\n@@ -1 +1 @@\n-before\n+after\n';
  expect(await registrationSupplies(root, engine, [modify], ['ephemeral.mjs'])).not.toContain(
    'ephemeral.mjs'
  );
  const created =
    'diff --git a/new.mjs b/new.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/new.mjs\n@@ -0,0 +1 @@\n+new\n';
  const deleted =
    'diff --git a/new.mjs b/new.mjs\ndeleted file mode 100644\n--- a/new.mjs\n+++ /dev/null\n@@ -1 +0,0 @@\n-new\n';
  expect(await registrationSupplies(root, engine, [created], ['new.mjs'])).toContain('new.mjs');
  expect(await registrationSupplies(root, engine, [created, deleted], ['new.mjs'])).not.toContain(
    'new.mjs'
  );
  expect(await registrationSupplies(root, engine, [], ['base.txt'])).toContain('base.txt');
  await runGit(engine, ['add', 'ephemeral.mjs']);
  expect(await registrationSupplies(root, engine, [], ['ephemeral.mjs'])).not.toContain(
    'ephemeral.mjs'
  );
});
it('accepts only an exact declared Furnace source instead of any file under its deployed prefix', async () => {
  const { root, engine } = await fixture();
  const target = 'toolkit/content/widgets/moz-fixture';
  await writeFile(
    join(root, 'furnace.json'),
    JSON.stringify({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {
        'moz-fixture': {
          targetPath: target,
          localized: false,
          register: false,
          description: 'fixture',
        },
      },
    })
  );
  await mkdir(join(root, 'components/custom/moz-fixture'), { recursive: true });
  await writeFile(join(root, 'components/custom/moz-fixture/real.mjs'), 'source\n');
  const files = [`${target}/real.mjs`, `${target}/unowned.mjs`, `${target}/../other.mjs`];
  expect(await registrationSupplies(root, engine, [], files)).toEqual(new Set([files[0]]));
});

it('uses committed mode metadata for a hand-written patch without mode headers', async () => {
  const { engine, patches } = await fixture();
  await writeFile(join(engine, 'owned.txt'), 'modified\n');
  await install(
    patches,
    'diff --git a/owned.txt b/owned.txt\n--- a/owned.txt\n+++ b/owned.txt\n@@ -1 +1 @@\n-original\n+modified\n',
    'owned.txt'
  );
  expect(
    (
      await classifyFiles(
        [{ status: ' M', file: 'owned.txt' }],
        engine,
        patches,
        'fixture',
        new Set()
      )
    )[0]?.classification
  ).toBe('patch-backed');
});

it('recognizes only Furnace files that its typed deployment actually copies', async () => {
  const { root, engine } = await fixture();
  const ftl = 'toolkit/locales/en-US/toolkit/global';
  const custom = 'toolkit/content/widgets/moz-local';
  const override = 'toolkit/content/widgets/moz-base';
  await writeFile(
    join(root, 'furnace.json'),
    JSON.stringify({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'moz-base': { type: 'full', description: 'base', basePath: override, baseVersion: '140' },
      },
      custom: {
        'moz-local': {
          targetPath: custom,
          localized: true,
          register: false,
          description: 'localized',
        },
      },
    })
  );
  for (const dir of ['components/custom/moz-local/sub', 'components/overrides/moz-base'])
    await mkdir(join(root, dir), { recursive: true });
  for (const path of [
    'components/custom/moz-local/moz-local.ftl',
    'components/custom/moz-local/ignored.txt',
    'components/custom/moz-local/sub/nested.mjs',
    'components/overrides/moz-base/base.mjs',
    'components/overrides/moz-base/base.ftl',
  ])
    await writeFile(join(root, path), 'source');
  const allowed = [`${ftl}/moz-local.ftl`, `${override}/base.mjs`, `${ftl}/base.ftl`];
  const refused = [
    `${custom}/ignored.txt`,
    `${custom}/sub/nested.mjs`,
    `${ftl}/missing.ftl`,
    `${override}/missing.css`,
  ];
  expect(await registrationSupplies(root, engine, [], [...allowed, ...refused])).toEqual(
    new Set(allowed)
  );
});
it('refuses an unreadable or unknown committed baseline instead of treating the inventory as empty', async () => {
  const { root, engine } = await fixture();
  await mkdir(join(root, '.fireforge'), { recursive: true });
  await writeFile(
    join(root, '.fireforge/state.json'),
    JSON.stringify({ baseCommit: '1'.repeat(40) })
  );
  await expect(registrationSupplies(root, engine, [], ['base.txt'])).rejects.toThrow();
});
