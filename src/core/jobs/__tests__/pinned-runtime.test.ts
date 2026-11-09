// SPDX-License-Identifier: EUPL-1.2
/** Pinning one FireForge build per host: what is copied, how it is verified, and what starts from it. */
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensureSupervisor, initializeCoordinator } from '../client.js';
import {
  pinnedEntry,
  pinnedPackage,
  PinnedRuntimeError,
  pinPreviousRuntime,
  pinRuntime,
  readPinnedRuntime,
} from '../pinned-runtime.js';
import type { CoordinatorConfig } from '../schema.js';
import { EXECUTOR, fakePackage } from './pinned-fixture.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const runtime: CoordinatorConfig['runtime'] = { node: process.execPath, environment: {} };

async function scratch(): Promise<{ directory: string; namespace: string }> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'fireforge-pin-')));
  directories.push(directory);
  return { directory, namespace: join(directory, 'coordinator') };
}

describe('pinning a FireForge build', () => {
  it('copies what a supervisor runs, records its identity, and verifies it before use', async () => {
    const { directory, namespace } = await scratch();
    const from = await fakePackage(join(directory, 'checkout'));
    const { record, changed } = await pinRuntime(namespace, { from, runtime });
    expect(changed).toBe(true);
    expect(record.current).toMatchObject({
      version: '9.9.9+gabc1234',
      executorDigest: EXECUTOR,
      protocol: 1,
      source: from,
    });
    expect(record.previous).toBeUndefined();
    expect(await readPinnedRuntime(namespace)).toEqual(record);
    const root = pinnedPackage(namespace, record.current);
    expect(await readdir(join(root, 'node_modules'))).toEqual(['dep', 'nested']);
    expect(await readdir(join(root, 'dist/src/core/jobs'))).toEqual(['supervisor-main.js']);
    expect(await readFile(join(root, 'runtime/qualified-node-bootstrap.cjs'), 'utf8')).toBe(
      '// bootstrap\n'
    );
    const entry = await pinnedEntry(namespace);
    expect(entry?.supervisor).toBe(join(root, 'dist/src/core/jobs/supervisor-main.js'));
    expect(entry?.cli).toBe(join(root, 'dist/bin/fireforge.js'));

    await writeFile(join(root, 'node_modules/dep/index.js'), 'module.exports = 3;\n');
    await expect(pinnedEntry(namespace)).rejects.toThrow(
      /pinned FireForge 9\.9\.9\+gabc1234 .* is not the bytes host upgrade verified; pin a build again: fireforge host upgrade/
    );
  });

  it('takes dependencies an install hoisted above the package', async () => {
    const { directory, namespace } = await scratch();
    const project = join(directory, 'project');
    const from = await fakePackage(join(project, 'node_modules/@fixture/fireforge'), {
      modules: join(project, 'node_modules'),
    });
    const { record } = await pinRuntime(namespace, { from, runtime });
    expect(await readdir(join(pinnedPackage(namespace, record.current), 'node_modules'))).toEqual([
      'dep',
      'nested',
    ]);
  });

  it('keeps the previous build for a rollback and removes older ones, except the one running', async () => {
    const { directory, namespace } = await scratch();
    const first = await fakePackage(join(directory, 'one'), { executor: '1'.repeat(64) });
    const second = await fakePackage(join(directory, 'two'), { executor: '2'.repeat(64) });
    await put(join(second, 'dist/src/extra.js'), 'two\n');
    const third = await fakePackage(join(directory, 'three'), { executor: '3'.repeat(64) });
    await put(join(third, 'dist/src/extra.js'), 'three\n');

    const one = (await pinRuntime(namespace, { from: first, runtime })).record.current;
    expect((await pinRuntime(namespace, { from: first, runtime })).changed).toBe(false);
    const two = (await pinRuntime(namespace, { from: second, runtime })).record;
    expect(two.previous?.id).toBe(one.id);
    const three = (
      await pinRuntime(namespace, {
        from: third,
        runtime,
        running: pinnedPackage(namespace, one),
      })
    ).record;
    expect(three.previous?.id).toBe(two.current.id);
    // The first build is no record's any more, but a supervisor still runs from it.
    await expect(readdir(pinnedPackage(namespace, one))).resolves.toBeDefined();
    await pinRuntime(namespace, { from: second, runtime });
    await expect(readdir(pinnedPackage(namespace, one))).rejects.toThrow(/ENOENT/);

    const back = await pinPreviousRuntime(namespace);
    expect(back.current.id).toBe(three.current.id);
    expect(back.previous?.id).toBe(two.current.id);
  });

  it('refuses a rollback with no previous build, an unbuilt package, and one that does not run', async () => {
    const { directory, namespace } = await scratch();
    await expect(pinPreviousRuntime(namespace)).rejects.toThrow(/no previous pinned FireForge/);
    const unbuilt = await fakePackage(join(directory, 'unbuilt'));
    await rm(join(unbuilt, 'dist'), { recursive: true });
    await expect(pinRuntime(namespace, { from: unbuilt, runtime })).rejects.toThrow(
      /has no dist\/src\/core\/jobs\/supervisor-main\.js; build it first \(npm run build\)/
    );
    await put(join(directory, 'other/package.json'), JSON.stringify({ name: 'x', version: '1' }));
    await expect(
      pinRuntime(namespace, { from: join(directory, 'other'), runtime })
    ).rejects.toBeInstanceOf(PinnedRuntimeError);
    const broken = await fakePackage(join(directory, 'broken'), { cliExit: 3 });
    await expect(pinRuntime(namespace, { from: broken, runtime })).rejects.toThrow(
      /did not run under/
    );
    expect(await readPinnedRuntime(namespace)).toBeUndefined();
  });

  it('starts the supervisor from the pinned build, whatever client starts it', async () => {
    const { directory, namespace } = await scratch();
    await initializeCoordinator(namespace, { idleMs: 60_000 });
    const marker = join(directory, 'supervisor-started');
    const from = await fakePackage(join(directory, 'checkout'), { marker });
    await pinRuntime(namespace, { from, runtime });
    await expect(ensureSupervisor(namespace, 10_000)).rejects.toThrow(/pinned supervisor ran/);
    expect(await readFile(marker, 'utf8')).toBe(namespace);

    const { current } = (await readPinnedRuntime(namespace)) ?? {};
    if (current === undefined) throw new Error('pinned record missing');
    await rm(pinnedPackage(namespace, current), { recursive: true });
    await expect(ensureSupervisor(namespace, 10_000)).rejects.toThrow(
      /pinned FireForge 9\.9\.9\+gabc1234 is missing/
    );
  });
});
