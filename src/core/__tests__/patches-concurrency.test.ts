// SPDX-License-Identifier: EUPL-1.2
import { mkdir, mkdtemp, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withPatchDirectoryLock } from '../patch-apply.js';
import { commitExportedPatch } from '../patch-export.js';
import { loadPatchesManifest } from '../patch-manifest.js';

async function createTempPatchesDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fireforge-patches-'));
}

describe('commitExportedPatch', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('serializes concurrent exports so patch numbers and manifest state stay aligned', async () => {
    const patchesDir = await createTempPatchesDir();
    tempDirs.push(patchesDir);

    const [first, second] = await Promise.all([
      commitExportedPatch({
        patchesDir,
        category: 'ui',
        name: 'first',
        description: 'first patch',
        diff: 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -0,0 +1 @@\n+first\n',
        filesAffected: ['a.js'],
        sourceEsrVersion: '140.0esr',
      }),
      commitExportedPatch({
        patchesDir,
        category: 'ui',
        name: 'second',
        description: 'second patch',
        diff: 'diff --git a/b.js b/b.js\n--- a/b.js\n+++ b/b.js\n@@ -0,0 +1 @@\n+second\n',
        filesAffected: ['b.js'],
        sourceEsrVersion: '140.0esr',
      }),
    ]);

    const exportedFilenames = [first.patchFilename, second.patchFilename];
    expect(exportedFilenames).toHaveLength(2);
    expect(new Set(exportedFilenames).size).toBe(2);
    expect(exportedFilenames.filter((name) => name.startsWith('001-'))).toHaveLength(1);
    expect(exportedFilenames.filter((name) => name.startsWith('002-'))).toHaveLength(1);
    expect(exportedFilenames.some((name) => name.endsWith('-first.patch'))).toBe(true);
    expect(exportedFilenames.some((name) => name.endsWith('-second.patch'))).toBe(true);

    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches).toHaveLength(2);
    const manifestFilenames = manifest?.patches.map((patch) => patch.filename) ?? [];
    expect(new Set(manifestFilenames)).toEqual(
      new Set([first.patchFilename, second.patchFilename])
    );

    const patchFiles = (await readdir(patchesDir))
      .filter((entry) => entry.endsWith('.patch'))
      .sort();
    expect(new Set(patchFiles)).toEqual(new Set([first.patchFilename, second.patchFilename]));
  });
});

describe('withPatchDirectoryLock - stale lock recovery', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('removes a stale lock directory and proceeds', async () => {
    const patchesDir = await mkdtemp(join(tmpdir(), 'fireforge-stale-lock-'));
    tempDirs.push(patchesDir);

    const lockDir = join(patchesDir, '.fireforge-patches.lock');
    await mkdir(lockDir);

    // Set mtime to 10 minutes ago
    const oldTime = new Date(Date.now() - 10 * 60_000);
    await utimes(lockDir, oldTime, oldTime);

    const result = await withPatchDirectoryLock(patchesDir, () => Promise.resolve('ok'));
    expect(result).toBe('ok');
  });
});
