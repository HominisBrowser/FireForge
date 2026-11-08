// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { dependencyGraphIdentity } from '../dependency-identity.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function put(root: string, file: string, bytes: string): Promise<void> {
  await mkdir(dirname(join(root, file)), { recursive: true });
  await writeFile(join(root, file), bytes);
}
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ff-dependency-identity-'));
  roots.push(root);
  await put(root, 'package.json', JSON.stringify({ dependencies: { a: '1' } }));
  await put(
    root,
    'node_modules/a/package.json',
    JSON.stringify({ name: 'a', dependencies: { b: '1' }, optionalDependencies: { absent: '1' } })
  );
  await put(root, 'node_modules/a/index.mjs', 'export const a = 1;');
  await put(
    root,
    'node_modules/b/package.json',
    JSON.stringify({ name: 'b', dependencies: { a: '1' } })
  );
  await put(root, 'node_modules/b/data.bin', 'runtime bytes');
  return root;
}

it('binds transitive runtime bytes, hoisted cycles, optional absence and install-independent identity', async () => {
  const first = await fixture();
  const second = await fixture();
  const before = await dependencyGraphIdentity(first);
  expect(await dependencyGraphIdentity(second)).toBe(before);
  await put(first, 'node_modules/b/data.bin', 'changed runtime bytes');
  expect(await dependencyGraphIdentity(first)).not.toBe(before);
  await put(second, 'node_modules/absent/package.json', '{"name":"absent"}');
  expect(await dependencyGraphIdentity(second)).not.toBe(before);
});

it('refuses missing required dependencies, optional peers cannot weaken required imports, and unsafe names', async () => {
  const root = await fixture();
  await put(
    root,
    'node_modules/a/package.json',
    JSON.stringify({
      dependencies: { missing: '1' },
      peerDependencies: { missing: '1' },
      peerDependenciesMeta: { missing: { optional: true } },
    })
  );
  await expect(dependencyGraphIdentity(root)).rejects.toThrow('required runtime dependency');
  await put(
    root,
    'node_modules/a/package.json',
    JSON.stringify({ dependencies: { '../outside': '1' } })
  );
  await expect(dependencyGraphIdentity(root)).rejects.toThrow('Invalid dependency package');
});

it('refuses unauthenticated runtime file symlinks rather than omitting their target bytes', async () => {
  const root = await fixture();
  await symlink('index.mjs', join(root, 'node_modules/a/alias.mjs'));
  await expect(dependencyGraphIdentity(root)).rejects.toThrow('runtime symlink');
});

it('can bind an installed project tool root as well as its dependency closure', async () => {
  const root = await fixture();
  await put(root, 'dist/index.js', 'export const tool = 1;');
  const inherited = await dependencyGraphIdentity(root);
  const bound = await dependencyGraphIdentity(root, { includeRootFiles: true });
  await put(root, 'dist/index.js', 'export const tool = 2;');
  expect(await dependencyGraphIdentity(root)).toBe(inherited);
  expect(await dependencyGraphIdentity(root, { includeRootFiles: true })).not.toBe(bound);
});
