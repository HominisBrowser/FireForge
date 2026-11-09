// SPDX-License-Identifier: EUPL-1.2
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { readLockStatus } from '../../file-lock.js';
import { writeAuthoredSourceFile } from '../writer.js';
import { sourceFixture } from './fixtures.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

it('serializes an aliased worktree root across actual Node processes', async () => {
  const value = await sourceFixture();
  directories.push(dirname(value.root));
  const alias = join(dirname(value.root), 'alias');
  await symlink(value.root, alias, 'dir');
  const script = join(dirname(value.root), 'hold.mjs');
  await writeFile(
    script,
    [
      `import { once } from 'node:events';`,
      `import { withAuthoredPathLock } from ${JSON.stringify(new URL('../write-lock.ts', import.meta.url).href)};`,
      `const release = once(process, 'message');`,
      `await withAuthoredPathLock(${JSON.stringify(alias)}, 'browser/new.js', async () => { process.send({ locked: true }); await release; });`,
      `process.disconnect();`,
    ].join('\n')
  );
  const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), script], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let publication: Promise<void> | undefined;
  try {
    await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw new Error(`Lock fixture exited before ownership: ${stderr}`);
      }),
    ]);
    const expected = await readFile(join(value.root, 'src/browser/new.js'));
    let published = false;
    publication = writeAuthoredSourceFile(
      value.root,
      'browser/new.js',
      Buffer.from('cross-process publication\n'),
      { expected, pristineRepository: value.pristine }
    ).then(() => {
      published = true;
    });
    const directory = join(value.root, '.fireforge/authored-writers');
    const name = (await readdir(directory)).find((file) => file.endsWith('.lock'));
    if (!name) throw new Error('Expected a real cross-process path lock');
    await vi.waitFor(
      async () => {
        expect((await readLockStatus(join(directory, name))).queueDepth).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 20 }
    );
    expect(published).toBe(false);
    expect(await readFile(join(value.root, 'src/browser/new.js'))).toEqual(expected);
    child.send({ release: true });
    await publication;
    expect(await readFile(join(value.root, 'src/browser/new.js'), 'utf8')).toBe(
      'cross-process publication\n'
    );
  } finally {
    if (child.connected) child.send({ release: true });
    await Promise.allSettled([exited, ...(publication ? [publication] : [])]);
  }
  expect(child.exitCode).toBe(0);
}, 15_000);
