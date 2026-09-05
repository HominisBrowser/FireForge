// SPDX-License-Identifier: EUPL-1.2
/**
 * Tests for the manifest-io mutation helpers: removePatchFromManifest,
 * renumberPatchesInManifest (including the two-phase rename collision
 * case), and removePatchFileAndManifest. Build a fake patches directory
 * on a temp dir and exercise the helpers directly, with no CLI in the loop.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir } from '../../utils/fs.js';
import { withPatchDirectoryLock } from '../patch-lock.js';
import {
  addPatchToManifest,
  loadPatchesManifest,
  type PatchRenameEntry,
  removePatchFileAndManifest,
  removePatchFromManifest,
  renumberPatchesInManifest,
  rewriteStagedDependencyOwners,
  savePatchesManifest,
} from '../patch-manifest-io.js';
import { stampPatchVersions } from '../patch-manifest-query.js';

/**
 * The manifest mutators assert that the patch-directory lock is held, which
 * every production caller does via `withPatchDirectoryLock`. These wrappers
 * let the tests exercise the same contract instead of calling in unlocked.
 */
function renumberUnderLock(dir: string, renameMap: Map<string, PatchRenameEntry>): Promise<void> {
  return withPatchDirectoryLock(dir, () => renumberPatchesInManifest(dir, renameMap));
}

function removeUnderLock(dir: string, filename: string): Promise<void> {
  return withPatchDirectoryLock(dir, () => removePatchFileAndManifest(dir, filename));
}

interface PatchSetup {
  filename: string;
  order: number;
  body: string;
}

async function seed(patchesDir: string, patches: PatchSetup[]): Promise<void> {
  await ensureDir(patchesDir);
  const metadata: PatchMetadata[] = patches.map((p) => ({
    filename: p.filename,
    order: p.order,
    category: 'infra',
    name: 'test',
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [`fake/${p.filename}.txt`],
  }));
  for (const p of patches) {
    await writeFile(join(patchesDir, p.filename), p.body);
  }
  const manifest: PatchesManifest = { version: 1, patches: metadata };
  await savePatchesManifest(patchesDir, manifest);
}

describe('removePatchFromManifest', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-remove-');
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('removes a single row and leaves the ordinal gap', async () => {
    await seed(patchesDir, [
      { filename: '001-infra-a.patch', order: 1, body: 'a' },
      { filename: '002-infra-b.patch', order: 2, body: 'b' },
      { filename: '003-infra-c.patch', order: 3, body: 'c' },
    ]);
    const removed = await removePatchFromManifest(patchesDir, '002-infra-b.patch');
    expect(removed).toBe(true);
    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches.map((p) => p.filename)).toEqual([
      '001-infra-a.patch',
      '003-infra-c.patch',
    ]);
    // The ordinals are left intact. There is no auto-renumber on delete.
    expect(manifest?.patches.map((p) => p.order)).toEqual([1, 3]);
  });

  it('returns false when the filename does not exist', async () => {
    await seed(patchesDir, [{ filename: '001-infra-a.patch', order: 1, body: 'a' }]);
    const removed = await removePatchFromManifest(patchesDir, 'ghost.patch');
    expect(removed).toBe(false);
  });
});

describe('rewriteStagedDependencyOwners', () => {
  const base: PatchMetadata = {
    filename: '001-infra-a.patch',
    order: 1,
    category: 'infra',
    name: 'test',
    description: 'test',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: ['foo/A.sys.mjs'],
  };

  it('returns the same object when there are no staged dependencies', () => {
    expect(rewriteStagedDependencyOwners(base, () => 'x.patch')).toBe(base);
  });

  it('returns the same object when no owner matches the lookup', () => {
    const patch: PatchMetadata = {
      ...base,
      stagedDependencies: {
        forwardImports: [
          { file: 'a', specifier: 's', creates: 'c', owner: '005-infra-e.patch' },
          { file: 'b', specifier: 't', creates: 'd' },
        ],
      },
    };
    expect(rewriteStagedDependencyOwners(patch, () => undefined)).toBe(patch);
  });

  it('remaps matching owners and leaves other imports untouched', () => {
    const patch: PatchMetadata = {
      ...base,
      stagedDependencies: {
        forwardImports: [
          { file: 'a', specifier: 's', creates: 'c', owner: '005-infra-e.patch' },
          { file: 'b', specifier: 't', creates: 'd', owner: '007-infra-g.patch' },
          { file: 'e', specifier: 'u', creates: 'f' },
        ],
      },
    };
    const result = rewriteStagedDependencyOwners(patch, (old) =>
      old === '005-infra-e.patch' ? '003-infra-e.patch' : undefined
    );
    expect(result).not.toBe(patch);
    expect(result.stagedDependencies?.forwardImports?.map((fi) => fi.owner)).toEqual([
      '003-infra-e.patch',
      '007-infra-g.patch',
      undefined,
    ]);
    // Input must not be mutated.
    expect(patch.stagedDependencies?.forwardImports?.[0]?.owner).toBe('005-infra-e.patch');
  });
});

describe('renumberPatchesInManifest', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-renumber-');
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('renames both files and manifest rows', async () => {
    await seed(patchesDir, [
      { filename: '001-infra-a.patch', order: 1, body: 'a' },
      { filename: '002-infra-b.patch', order: 2, body: 'b' },
    ]);

    await renumberUnderLock(
      patchesDir,
      new Map([
        ['001-infra-a.patch', { newFilename: '002-infra-a.patch', newOrder: 2 }],
        ['002-infra-b.patch', { newFilename: '001-infra-b.patch', newOrder: 1 }],
      ])
    );

    // Both files must exist with their new names, both old names gone.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch'));
    expect(entries.sort()).toEqual(['001-infra-b.patch', '002-infra-a.patch']);

    // Bodies must still match their original content (renamed in place,
    // not rewritten).
    expect(await readFile(join(patchesDir, '002-infra-a.patch'), 'utf-8')).toBe('a');
    expect(await readFile(join(patchesDir, '001-infra-b.patch'), 'utf-8')).toBe('b');

    // Manifest rows must reflect the new filenames and orders.
    const manifest = await loadPatchesManifest(patchesDir);
    const byFilename = new Map(manifest?.patches.map((p) => [p.filename, p]));
    expect(byFilename.get('001-infra-b.patch')?.order).toBe(1);
    expect(byFilename.get('002-infra-a.patch')?.order).toBe(2);
  });

  it('handles a shift that would collide without two-phase staging', async () => {
    // 003 → 005 while 005 is also moving (to 004). Direct rename would
    // clobber the file at 005. Two-phase staging must handle it.
    await seed(patchesDir, [
      { filename: '003-infra-c.patch', order: 3, body: 'C' },
      { filename: '004-infra-d.patch', order: 4, body: 'D' },
      { filename: '005-infra-e.patch', order: 5, body: 'E' },
    ]);

    await renumberUnderLock(
      patchesDir,
      new Map([
        ['003-infra-c.patch', { newFilename: '005-infra-c.patch', newOrder: 5 }],
        ['004-infra-d.patch', { newFilename: '003-infra-d.patch', newOrder: 3 }],
        ['005-infra-e.patch', { newFilename: '004-infra-e.patch', newOrder: 4 }],
      ])
    );

    expect(await readFile(join(patchesDir, '005-infra-c.patch'), 'utf-8')).toBe('C');
    expect(await readFile(join(patchesDir, '003-infra-d.patch'), 'utf-8')).toBe('D');
    expect(await readFile(join(patchesDir, '004-infra-e.patch'), 'utf-8')).toBe('E');

    const manifest = await loadPatchesManifest(patchesDir);
    const byOrder = manifest?.patches.map((p) => `${p.order}:${p.filename}`).sort();
    expect(byOrder).toEqual(['3:003-infra-d.patch', '4:004-infra-e.patch', '5:005-infra-c.patch']);
  });

  it('no-op when rename map is empty', async () => {
    await seed(patchesDir, [{ filename: '001-infra-a.patch', order: 1, body: 'a' }]);
    await renumberUnderLock(patchesDir, new Map());
    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches).toHaveLength(1);
  });

  it('rewrites staged-dependency owners on non-renamed rows', async () => {
    // 001 declares a forward import owned by 003. Renumbering 003 → 002
    // must remap the owner even though 001 itself is not in the rename map.
    await seed(patchesDir, [
      { filename: '001-infra-a.patch', order: 1, body: 'a' },
      { filename: '003-infra-c.patch', order: 3, body: 'c' },
    ]);
    const manifest = await loadPatchesManifest(patchesDir);
    if (!manifest) throw new Error('manifest missing');
    const holder = manifest.patches.find((p) => p.filename === '001-infra-a.patch');
    if (!holder) throw new Error('holder missing');
    holder.stagedDependencies = {
      forwardImports: [
        {
          file: 'foo/A.sys.mjs',
          specifier: 'resource:///modules/C.sys.mjs',
          creates: 'foo/C.sys.mjs',
          owner: '003-infra-c.patch',
        },
      ],
    };
    await savePatchesManifest(patchesDir, manifest);

    await renumberUnderLock(
      patchesDir,
      new Map([['003-infra-c.patch', { newFilename: '002-infra-c.patch', newOrder: 2 }]])
    );

    const updated = await loadPatchesManifest(patchesDir);
    const holderAfter = updated?.patches.find((p) => p.filename === '001-infra-a.patch');
    expect(holderAfter?.stagedDependencies?.forwardImports?.[0]?.owner).toBe('002-infra-c.patch');
  });

  it('rolls the queue back to the pre-operation state when phase 2 fails', async () => {
    // Phase 2 rollback: a partial phase-2 failure otherwise leaves some
    // files at their final names and the rest at staging names, and asks the
    // operator to reach for `doctor --repair-patches-manifest`, a blunt
    // last-resort rebuild. The rollback reverses every completed rename back
    // to the pre-operation state so the directory and manifest stay in
    // agreement without a separate recovery pass.
    //
    // Force phase 2 to fail on the second rename by planting a pre-existing
    // file at the would-be target (`006-infra-b.patch`): phase 2 checks
    // `pathExists(targetPath)` before each rename and throws on the
    // conflict. By then it has already renamed the first staged file to its
    // final name, so rollback must revert both.
    await seed(patchesDir, [
      { filename: '003-infra-a.patch', order: 3, body: 'A' },
      { filename: '004-infra-b.patch', order: 4, body: 'B' },
    ]);
    await writeFile(join(patchesDir, '006-infra-b.patch'), 'PLANTED');

    await expect(
      renumberUnderLock(
        patchesDir,
        new Map([
          ['003-infra-a.patch', { newFilename: '005-infra-a.patch', newOrder: 5 }],
          ['004-infra-b.patch', { newFilename: '006-infra-b.patch', newOrder: 6 }],
        ])
      )
    ).rejects.toThrow(/already exists on disk/);

    // Both original patch files must be back at their starting names
    // with their original content. The planted file at 006 must still
    // be there (the rollback doesn't touch it, because it was never part
    // of the operation).
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toContain('003-infra-a.patch');
    expect(entries).toContain('004-infra-b.patch');
    expect(entries).toContain('006-infra-b.patch');
    expect(entries).not.toContain('005-infra-a.patch');

    expect(await readFile(join(patchesDir, '003-infra-a.patch'), 'utf-8')).toBe('A');
    expect(await readFile(join(patchesDir, '004-infra-b.patch'), 'utf-8')).toBe('B');
    expect(await readFile(join(patchesDir, '006-infra-b.patch'), 'utf-8')).toBe('PLANTED');

    // No staging residue.
    const staging = (await readdir(patchesDir)).filter((f) => f.startsWith('.fireforge-renumber-'));
    expect(staging).toEqual([]);

    // Manifest rows must match the pre-operation state. Nothing was
    // written, so nothing should have changed.
    const manifest = await loadPatchesManifest(patchesDir);
    const byFilename = new Map(manifest?.patches.map((p) => [p.filename, p]));
    expect(byFilename.get('003-infra-a.patch')?.order).toBe(3);
    expect(byFilename.get('004-infra-b.patch')?.order).toBe(4);
  });
});

describe('removePatchFileAndManifest', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-removefile-');
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('removes both the patch file and the manifest row', async () => {
    await seed(patchesDir, [
      { filename: '001-infra-a.patch', order: 1, body: 'a' },
      { filename: '002-infra-b.patch', order: 2, body: 'b' },
    ]);
    await removeUnderLock(patchesDir, '001-infra-a.patch');
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch'));
    expect(entries).toEqual(['002-infra-b.patch']);
    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches.map((p) => p.filename)).toEqual(['002-infra-b.patch']);
  });
});

// addPatchToManifest is exercised indirectly elsewhere. Keep a smoke test
// here so the refactor is covered end-to-end.
describe('addPatchToManifest (smoke)', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-add-');
    patchesDir = join(projectRoot, 'patches');
    await ensureDir(patchesDir);
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('appends a new row and sorts by order', async () => {
    await addPatchToManifest(patchesDir, {
      filename: '002-infra-b.patch',
      order: 2,
      category: 'infra',
      name: 'b',
      description: '',
      createdAt: '',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: [],
    });
    await addPatchToManifest(patchesDir, {
      filename: '001-infra-a.patch',
      order: 1,
      category: 'infra',
      name: 'a',
      description: '',
      createdAt: '',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: [],
    });
    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches.map((p) => p.order)).toEqual([1, 2]);
  });
});

describe('stampPatchVersions', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-stamp-');
    patchesDir = join(projectRoot, 'patches');
  });
  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('stamps sourceVersion and sourceProduct on the selected rows', async () => {
    await seed(patchesDir, [
      { filename: '001-infra-a.patch', order: 1, body: 'a' },
      { filename: '002-infra-b.patch', order: 2, body: 'b' },
    ]);
    await stampPatchVersions(patchesDir, ['002-infra-b.patch'], '141.0.0esr', 'firefox-esr');
    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches[0]?.sourceEsrVersion).toBe('140.9.0esr');
    expect(manifest?.patches[1]?.sourceEsrVersion).toBe('141.0.0esr');
  });

  it('waits for the patch-directory lock before mutating the manifest', async () => {
    await seed(patchesDir, [{ filename: '001-infra-a.patch', order: 1, body: 'a' }]);

    let releaseLock: () => void = () => undefined;
    const lockHeld = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let lockAcquired: () => void = () => undefined;
    const lockAcquiredPromise = new Promise<void>((resolve) => {
      lockAcquired = resolve;
    });

    const holder = withPatchDirectoryLock(patchesDir, async () => {
      lockAcquired();
      await lockHeld;
    });
    await lockAcquiredPromise;

    const stamp = stampPatchVersions(patchesDir, ['001-infra-a.patch'], '141.0.0esr');

    // Give the stamp time to run if it were (incorrectly) not honoring the
    // lock. The manifest must still carry the old version while it is held.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const during = await loadPatchesManifest(patchesDir);
    expect(during?.patches[0]?.sourceEsrVersion).toBe('140.9.0esr');

    releaseLock();
    await holder;
    await stamp;

    const after = await loadPatchesManifest(patchesDir);
    expect(after?.patches[0]?.sourceEsrVersion).toBe('141.0.0esr');
  });
});
