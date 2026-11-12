// SPDX-License-Identifier: EUPL-1.2
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { git } from '../testing/git.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir } from '../testing/temp.js';
import { exportedPatchName, override, planQueueExport, type QueueExportPlan } from './index.js';

const dir = useTempDir();
const MANIFEST = 'browser/manifest.txt';

async function failureCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );
}

/** Applies the plan's patches in order onto a fresh pristine checkout, as `fireforge import` would. */
async function replay(value: SourceFixture, plan: QueueExportPlan, name: string): Promise<string> {
  const engine = await value.engine(join(dir(), name));
  for (const patch of plan.patches) {
    const file = join(dir(), `${name}-${patch.name}.patch`);
    await writeFile(file, patch.body);
    await git(engine, ['apply', '--binary', file]);
  }
  return engine;
}

async function plan(value: SourceFixture): Promise<QueueExportPlan> {
  return planQueueExport(await value.load(), value.pristine);
}

describe('planQueueExport', () => {
  it('plans a queue that replays onto the pristine tree byte for byte, the same every time', async () => {
    const value = await createSourceFixture(dir());
    const project = await value.load();
    await override(project, value.pristine, MANIFEST, { component: '012-ui-sidebar.patch' });
    for (const path of ['browser/blob.dat', 'browser/run.sh']) {
      await override(project, value.pristine, path, { component: 'infra-registration' });
    }
    await override(project, value.pristine, 'browser/base/jar.mn', {
      component: 'infra-registration',
      delete: true,
    });
    await value.write(
      {
        [`src/${MANIFEST}`]: 'first\nlocal\nthird\nfourth\nfifth\n',
        'src/browser/blob.dat': Buffer.from([9, 0, 255]),
        'src/browser/run.sh': '#!/bin/sh\nexit 1\n',
        'src/browser/crlf.txt': Buffer.from('a\r\nb\r\n'),
        'src/browser/tool.sh': '#!/bin/sh\n',
      },
      { executable: ['src/browser/tool.sh'] }
    );
    await value.commit();
    const first = await plan(value);
    expect(first.patches.map((patch) => [patch.group, patch.name, patch.files])).toEqual([
      ['012-ui-sidebar.patch', 'ui-sidebar', [MANIFEST]],
      [
        'infra-registration',
        'infra-registration',
        ['browser/base/jar.mn', 'browser/blob.dat', 'browser/run.sh'],
      ],
      ['created-root', 'created-root', ['browser/crlf.txt', 'browser/tool.sh']],
    ]);
    expect(first.manifestSource.pristineCommit).toBe(value.pristine.commit);
    expect(await plan(value)).toEqual(first);
    const engine = await replay(value, first, 'consumer');
    for (const path of [
      MANIFEST,
      'browser/blob.dat',
      'browser/run.sh',
      'browser/crlf.txt',
      'browser/tool.sh',
    ]) {
      expect((await readFile(join(engine, path))).toString('hex'), path).toBe(
        (await readFile(join(value.root, 'src', path))).toString('hex')
      );
      expect((await lstat(join(engine, path))).mode & 0o111, path).toBe(
        (await lstat(join(value.root, 'src', path))).mode & 0o111
      );
    }
    await expect(readFile(join(engine, 'browser/base/jar.mn'))).rejects.toThrow();
  });

  it('groups created files by named group and directory, and one edit changes one patch', async () => {
    const value = await createSourceFixture(dir(), {
      config: {
        exportQueue: {
          groups: [{ name: 'ui-tiles', paths: ['browser/tiles/**'] }],
          maxGroupBytes: 300,
        },
      },
    });
    await override(await value.load(), value.pristine, MANIFEST, {
      component: '012-ui-sidebar.patch',
    });
    const module = (name: string, tag: string): string =>
      `/** ${name} */\nexport const ${name} = ${JSON.stringify(tag.repeat(200))};\n`;
    await value.write({
      [`src/${MANIFEST}`]: 'first\nlocal\nthird\nfourth\nfifth\n',
      'src/browser/new.js': 'export const value = 1;\n',
      'src/browser/tiles/a.js': 'export const a = 1;\n',
      'src/browser/tiles/deep/b.js': 'export const b = 1;\n',
      'src/browser/modules/One.sys.mjs': module('one', 'x'),
      'src/browser/modules/Two.sys.mjs': module('two', 'y'),
      'src/browser/modules/test/test_one.js': 'add_task(() => {});\n',
      'src/toolkit/widgets/w.mjs': 'export class W {}\n',
    });
    const bodies = (queue: QueueExportPlan): Map<string, string> =>
      new Map(queue.patches.map((patch) => [patch.group, patch.body.toString('utf8')]));
    const first = await plan(value);
    expect(first.patches.map((patch) => patch.group)).toEqual([
      '012-ui-sidebar.patch',
      'created-browser',
      'created-browser-modules',
      'created-browser-modules-test',
      'created-toolkit',
      'ui-tiles',
    ]);
    expect(first.patches.find((patch) => patch.group === 'ui-tiles')?.files).toEqual([
      'browser/tiles/a.js',
      'browser/tiles/deep/b.js',
    ]);

    // An edit to one file changes that file's patch and the source, nothing else.
    await value.write({ 'src/browser/modules/One.sys.mjs': module('one', 'z') });
    const second = await plan(value);
    const [before, after] = [bodies(first), bodies(second)];
    expect([...after.keys()]).toEqual([...before.keys()]);
    expect(
      [...after].filter(([name, body]) => before.get(name) !== body).map(([name]) => name)
    ).toEqual(['created-browser-modules']);
    expect(second.manifestSource.digest).not.toBe(first.manifestSource.digest);

    // A new directory adds one patch and renames nothing.
    await value.write({ 'src/browser/extra/x.js': 'export const x = 1;\n' });
    const third = bodies(await plan(value));
    expect([...third.keys()].filter((name) => !after.has(name))).toEqual(['created-browser-extra']);
    for (const [name, body] of after) expect(third.get(name), name).toBe(body);
    await replay(value, await plan(value), 'consumer');
  });

  it('refuses two groups with one name, and a checkout verify finds problems in', async () => {
    const value = await createSourceFixture(dir());
    const project = await value.load();
    await override(project, value.pristine, MANIFEST, { component: 'ui-sidebar' });
    await override(project, value.pristine, 'browser/run.sh', {
      component: '012-ui-sidebar.patch',
    });
    await value.write({ [`src/${MANIFEST}`]: 'ours\n', 'src/browser/run.sh': 'ours\n' });
    expect(await failureCode(plan(value))).toBe('source-group-name-collision');
    await value.write({ 'src/toolkit/modules/Service.sys.mjs': 'undeclared\n' });
    expect(await failureCode(plan(value))).toBe('source-invalid');
  });
});

describe('exportedPatchName', () => {
  it.each([
    ['ui-sidebar', 'ui-sidebar'],
    ['012-ui-sidebar.patch', 'ui-sidebar'],
    ['browser', 'browser'],
    ['third_party', 'third-party'],
    ['Cargo.toml', 'cargo-toml'],
    ['created-browser-base', 'created-browser-base'],
  ])('names the patch of group %j %j, with nothing put in front', (id, name) => {
    expect(exportedPatchName(id)).toBe(name);
  });

  it('refuses an ID no patch can be named after', () => {
    for (const id of ['3d-view', '007.patch', '___']) {
      expect(() => exportedPatchName(id)).toThrow(
        expect.objectContaining({ code: 'source-group-unexportable' })
      );
    }
  });
});
