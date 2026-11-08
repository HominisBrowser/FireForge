// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { readJson, writeJson } from '../../utils/fs.js';
import { loadState } from '../config-state.js';
import { withStateFileLock } from '../state-file.js';

const observation = vi.hoisted(() => ({ path: '', read: () => {} }));
vi.mock('../../utils/fs.js', async (original) => {
  const actual = await original<typeof import('../../utils/fs.js')>();
  return {
    ...actual,
    readJson: async <T>(path: string): Promise<T> => {
      const value = await actual.readJson<T>(path);
      if (path === observation.path) observation.read();
      return value;
    },
  };
});
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const roots: string[] = [];
afterEach(async () => {
  observation.path = '';
  observation.read = () => {};
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it.each([{ brand: 'old', buildMode: 'invalid' }, { brand: 42 }])(
  'rereads under the recovery lock instead of quarantining a newer successful update: %j',
  async (invalid) => {
    const root = await mkdtemp(join(tmpdir(), 'ff-state-recovery-race-'));
    roots.push(root);
    const directory = join(root, '.fireforge'),
      path = join(directory, 'state.json');
    await mkdir(directory);
    await writeJson(path, invalid);
    const invalidRead = deferred();
    const writerReady = deferred();
    observation.path = path;
    observation.read = () => {
      invalidRead.resolve();
    };
    const valid = { brand: 'new-writer', buildMode: 'release', baseCommit: 'new-base' };
    const writer = withStateFileLock(path, async () => {
      writerReady.resolve();
      await invalidRead.promise;
      await writeJson(path, valid);
    });
    await writerReady.promise;
    const reader = loadState(root);
    await writer;
    await expect(reader).resolves.toEqual(valid);
    expect(await readJson(path)).toEqual(valid);
    expect((await readdir(directory)).filter((name) => name.includes('.corrupt-'))).toEqual([]);
  }
);
