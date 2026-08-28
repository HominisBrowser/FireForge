// SPDX-License-Identifier: EUPL-1.2
/**
 * Real-fs integration test for `withConfigFileLock`.
 *
 * Two concurrent `fireforge config` writes to the same `fireforge.json` can
 * silently clobber each other when the read-modify-write sequence is not
 * serialised behind a lock. The test schedules two lock-guarded writers that
 * each add a distinct key, then asserts both keys survive on disk.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { FireForgeConfig } from '../../types/config.js';
import { loadRawConfigDocument, withConfigFileLock, writeConfigDocument } from '../config.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fireforge-config-lock-'));
  cleanup.push(root);

  const baseConfig: FireForgeConfig = {
    name: 'My Browser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  };
  await writeFile(join(root, 'fireforge.json'), JSON.stringify(baseConfig, null, 2), 'utf-8');
  return root;
}

describe('withConfigFileLock', () => {
  it('serialises concurrent read-modify-write sequences so both writers survive', async () => {
    const root = await createProject();

    // Each writer reads the current document, adds its own key, and
    // writes the result back. Without the lock, both reads see the same
    // pre-state, both writes push their own mutation, and the later
    // rename wins — one key is lost. With the lock, the second writer
    // blocks until the first finishes, sees the first writer's update,
    // and merges against it.
    const writer = async (key: string, value: number): Promise<void> => {
      await withConfigFileLock(root, async () => {
        const current = await loadRawConfigDocument(root);
        await new Promise((resolve) => setTimeout(resolve, 15));
        await writeConfigDocument(root, { ...current, [key]: value });
      });
    };

    await Promise.all([writer('addedByFirst', 1), writer('addedBySecond', 2)]);

    const persisted = await loadRawConfigDocument(root);
    expect(persisted['addedByFirst']).toBe(1);
    expect(persisted['addedBySecond']).toBe(2);
    // The base keys must still be present — the merge must not drop the
    // pre-existing document shape.
    expect(persisted['binaryName']).toBe('mybrowser');
    expect(persisted['appId']).toBe('org.acme.browser');
  });

  it('propagates the writer operation return value', async () => {
    const root = await createProject();
    const result = await withConfigFileLock(root, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });

  it('releases the lock even when the operation throws', async () => {
    const root = await createProject();
    await expect(withConfigFileLock(root, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );

    // A subsequent lock-guarded operation must not hang — the finally
    // block in `withFileLock` should have removed the lock directory.
    const followupValue = await withConfigFileLock(root, async () => {
      const current = await loadRawConfigDocument(root);
      await writeConfigDocument(root, { ...current, touched: true });
      return 'followup-ok';
    });
    expect(followupValue).toBe('followup-ok');
    const persisted = JSON.parse(await readFile(join(root, 'fireforge.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(persisted['touched']).toBe(true);
  });
});
