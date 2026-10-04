// SPDX-License-Identifier: EUPL-1.2
import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, it } from 'vitest';

import { createTempProject, initCommittedRepo, removeTempProject } from '../test-utils/index.js';

const run = promisify(execFile);
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../scripts/generate-build-info.mjs'
);
let root: string;
beforeEach(async () => {
  root = await createTempProject('ff-input-identity-');
  await initCommittedRepo(root, {
    'package.json': '{"version":"1.2.3"}',
    '.gitignore': 'dist/\n',
    'tracked.bin': Buffer.from([0, 1, 2]),
  });
  await mkdir(join(root, 'scripts'));
  await copyFile(script, join(root, 'scripts/generate-build-info.mjs'));
});
afterEach(async () => {
  await removeTempProject(root);
});
async function hash(): Promise<unknown> {
  await run(process.execPath, ['scripts/generate-build-info.mjs'], { cwd: root });
  const info = JSON.parse(await readFile(join(root, 'dist/build-info.json'), 'utf8')) as {
    dirtyHash: unknown;
  };
  return info.dirtyHash;
}

it('changes identity with untracked text/binary bytes and stays stable for identical inputs', async () => {
  await writeFile(join(root, 'new.ts'), 'export const value = 1;\n');
  const first = await hash();
  expect(await hash()).toBe(first);
  await writeFile(join(root, 'new.ts'), 'export const value = 200;\n');
  const second = await hash();
  expect(second).not.toBe(first);
  await writeFile(join(root, 'new.bin'), Buffer.from([0, 1, 2]));
  const binary = await hash();
  await writeFile(join(root, 'new.bin'), Buffer.from([0, 1, 3]));
  expect(await hash()).not.toBe(binary);
  await writeFile(join(root, 'dist/generated-output'), 'different build output');
  const unchanged = await hash();
  await writeFile(join(root, 'dist/generated-output'), 'another generated output');
  expect(await hash()).toBe(unchanged);
});

it('changes identity with tracked binary bytes', async () => {
  const first = await hash();
  await writeFile(join(root, 'tracked.bin'), Buffer.from([0, 9, 2]));
  expect(await hash()).not.toBe(first);
});

it.skipIf(process.platform === 'win32')('includes input mode and symlink target', async () => {
  await writeFile(join(root, 'new.sh'), 'echo hello\n');
  await chmod(join(root, 'new.sh'), 0o644);
  const first = await hash();
  await chmod(join(root, 'new.sh'), 0o755);
  expect(await hash()).not.toBe(first);
  await symlink('new.sh', join(root, 'link'));
  const linked = await hash();
  await run(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'import {unlink,symlink} from "node:fs/promises"; await unlink("link"); await symlink("tracked.bin","link");',
    ],
    { cwd: root }
  );
  expect(await hash()).not.toBe(linked);
});
