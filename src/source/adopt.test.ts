// SPDX-License-Identifier: EUPL-1.2
import { chmod, cp, lstat, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { commitAll, git } from '../testing/git.js';
import { createSourceFixture, type SourceFixture } from '../testing/source.js';
import { useTempDir, writeTree } from '../testing/temp.js';
import { adoptTrees, materialize, verifySource } from './index.js';

const dir = useTempDir();

async function failureCode(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'none',
    (error: unknown) => (error as { code: string }).code
  );
}

/** A queue replayed onto the pristine commit: a checkout with the result committed. */
async function replayed(value: SourceFixture): Promise<{ repo: string; tree: string }> {
  const repo = await value.engine(join(dir(), 'replayed'));
  await git(repo, ['config', 'user.email', 'fireforge@example.test']);
  await git(repo, ['config', 'user.name', 'FireForge Tests']);
  await writeTree(repo, {
    'browser/manifest.txt': 'first\nlocal\nthird\nfourth\nfifth\n',
    'browser/blob.dat': Buffer.from([9, 0, 255]),
    'browser/crlf.txt': Buffer.from('a\r\nb\r\n'),
    'browser/tool.sh': '#!/bin/sh\n',
  });
  await chmod(join(repo, 'browser/tool.sh'), 0o755);
  await rm(join(repo, 'browser/base/jar.mn'));
  await commitAll(repo, 'queue');
  return { repo, tree: (await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim() };
}

describe('adoptTrees', () => {
  it('writes postimages, records and tombstones that materialize back to the result tree', async () => {
    const value = await createSourceFixture(dir());
    const result = await replayed(value);
    const overlay = join(dir(), 'overlay');
    await writeTree(value.root, { 'docs/adr/blob.md': 'Approved.\n' });
    const adopted = await adoptTrees(value.pristine, result, {
      destination: overlay,
      sourceRoot: 'src',
      metadataRoot: '.fireforge-sources',
      ownerOf: (path) =>
        path === 'browser/blob.dat'
          ? { component: 'infra-binary', adr: 'docs/adr/blob.md' }
          : { component: 'ui-sidebar' },
    });
    expect(adopted).toEqual({
      created: ['browser/crlf.txt', 'browser/tool.sh'],
      overridden: ['browser/blob.dat', 'browser/manifest.txt'],
      deleted: ['browser/base/jar.mn'],
    });
    const record = JSON.parse(
      await readFile(join(overlay, '.fireforge-sources/overrides/browser/blob.dat.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      kind: 'override',
      component: 'infra-binary',
      classification: 'exception',
      adr: 'docs/adr/blob.md',
    });

    // Adopted into the project, the overlay is valid and materializes to the result tree.
    await rm(join(value.root, 'src'), { recursive: true });
    await cp(overlay, value.root, { recursive: true });
    const project = await value.load();
    expect(await verifySource(project, value.pristine)).toEqual([]);
    const engine = await value.engine(join(dir(), 'workspace', 'engine'));
    await materialize(project, value.pristine, {
      engineDir: engine,
      stateDir: join(dir(), 'workspace'),
    });
    await git(engine, ['add', '-A']);
    expect((await git(engine, ['write-tree'])).trim()).toBe(result.tree);
    // Windows has no executable bit.
    if (process.platform !== 'win32') {
      expect((await lstat(join(engine, 'browser/tool.sh'))).mode & 0o111).not.toBe(0);
    }
    expect(await readFile(join(engine, 'browser/crlf.txt'))).toEqual(Buffer.from('a\r\nb\r\n'));
  });

  it('refuses a link among the changes and a destination that already holds source', async () => {
    const value = await createSourceFixture(dir());
    const repo = await value.engine(join(dir(), 'replayed'));
    await git(repo, ['config', 'user.email', 'fireforge@example.test']);
    await git(repo, ['config', 'user.name', 'FireForge Tests']);
    await symlink('manifest.txt', join(repo, 'browser/link'));
    await commitAll(repo, 'queue');
    const tree = (await git(repo, ['rev-parse', 'HEAD^{tree}'])).trim();
    const options = {
      destination: join(dir(), 'overlay'),
      sourceRoot: 'src',
      metadataRoot: '.fireforge-sources',
      ownerOf: () => ({ component: 'ui' }),
    };
    expect(await failureCode(adoptTrees(value.pristine, { repo, tree }, options))).toBe(
      'adopt-unsupported-kind'
    );
    expect(
      await failureCode(
        adoptTrees(value.pristine, { repo, tree }, { ...options, destination: value.root })
      )
    ).toBe('adopt-destination-not-empty');
  });
});
