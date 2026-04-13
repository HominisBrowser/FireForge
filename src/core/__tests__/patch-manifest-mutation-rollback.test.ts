// SPDX-License-Identifier: EUPL-1.2
/**
 * Regression coverage for manifest/file deletion rollback: if removing the
 * .patch file fails after the manifest row has been removed, the helper must
 * restore the original manifest so the queue does not drift into an orphaned
 * patch-on-disk / missing-row state.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTempProject, removeTempProject } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { ensureDir, removeFile, writeJson } from '../../utils/fs.js';
import {
  loadPatchesManifest,
  PatchDeleteRollbackError,
  removePatchFileAndManifest,
  renumberPatchesInManifest,
  savePatchesManifest,
} from '../patch-manifest-io.js';

vi.mock('../../utils/fs.js', async () => {
  const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
  return {
    ...actual,
    removeFile: vi.fn(actual.removeFile),
    writeJson: vi.fn(actual.writeJson),
  };
});

async function seed(patchesDir: string): Promise<void> {
  await ensureDir(patchesDir);
  const patches: PatchMetadata[] = [
    {
      filename: '001-infra-a.patch',
      order: 1,
      category: 'infra',
      name: 'a',
      description: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['fake/a.txt'],
    },
    {
      filename: '002-infra-b.patch',
      order: 2,
      category: 'infra',
      name: 'b',
      description: '',
      createdAt: '2025-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['fake/b.txt'],
    },
  ];

  await writeFile(join(patchesDir, '001-infra-a.patch'), 'a');
  await writeFile(join(patchesDir, '002-infra-b.patch'), 'b');
  await savePatchesManifest(patchesDir, { version: 1, patches });
}

describe('removePatchFileAndManifest rollback', () => {
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-rollback-');
    patchesDir = join(projectRoot, 'patches');
    vi.clearAllMocks();
    await seed(patchesDir);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('restores the original manifest when file deletion fails', async () => {
    vi.mocked(removeFile).mockImplementation(async (path: string) => {
      if (path.endsWith('001-infra-a.patch')) {
        throw new Error('simulated delete failure');
      }
      return Promise.resolve();
    });

    await expect(removePatchFileAndManifest(patchesDir, '001-infra-a.patch')).rejects.toThrow(
      'simulated delete failure'
    );

    const manifest = await loadPatchesManifest(patchesDir);
    expect(manifest?.patches.map((p) => p.filename)).toEqual([
      '001-infra-a.patch',
      '002-infra-b.patch',
    ]);

    const patchBody = await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8');
    expect(patchBody).toBe('a');

    const onDiskManifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(onDiskManifest.patches.map((p) => p.filename)).toEqual([
      '001-infra-a.patch',
      '002-infra-b.patch',
    ]);
  });

  it('throws PatchDeleteRollbackError when both delete and rollback fail', async () => {
    // Compound failure scenario: the file delete fails, so the helper
    // tries to restore the manifest — and the manifest restore also
    // fails. Previously this only produced a stderr warning alongside
    // the original delete error, which made the compound failure
    // invisible to programmatic callers and harder to spot in logs.
    // The fix raises a dedicated error type that surfaces both causes.
    //
    // removePatchFileAndManifest writes the manifest twice: once when
    // removePatchFromManifest commits the row removal, and a second
    // time when the delete-failure rollback tries to restore the
    // original. We need the first write to succeed and the second to
    // fail, so the mock counts calls.
    vi.mocked(removeFile).mockImplementation(() => {
      return Promise.reject(new Error('simulated delete failure'));
    });
    const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
    let writeJsonCalls = 0;
    vi.mocked(writeJson).mockImplementation(async (path: string, data: unknown) => {
      writeJsonCalls += 1;
      if (writeJsonCalls === 1) {
        // First write is the row-removal commit — let it through.
        return actual.writeJson(path, data);
      }
      // Second write is the rollback restore — fail it.
      throw new Error('simulated manifest rollback failure');
    });

    const error = await removePatchFileAndManifest(patchesDir, '001-infra-a.patch').catch(
      (e: unknown) => e
    );
    expect(error).toBeInstanceOf(PatchDeleteRollbackError);
    if (error instanceof PatchDeleteRollbackError) {
      expect(error.filename).toBe('001-infra-a.patch');
      expect(error.deleteError.message).toBe('simulated delete failure');
      expect(error.rollbackError.message).toBe('simulated manifest rollback failure');
    }
  });
});

describe('renumberPatchesInManifest phase-3 rollback', () => {
  // Phase-3 regression: phase 1 (stage) and phase 2 (stage → final) both
  // succeed, and then the final manifest save throws. Without the rollback
  // the directory would be fully renumbered while patches.json still
  // records the old names — the exact drift the two-phase rename is meant
  // to prevent. The fix reverses every completed final rename back to the
  // original filename before re-throwing, so the directory and manifest
  // stay in agreement even though the caller sees the save failure.
  //
  // The only way to fail the write at phase 3 specifically (and not the
  // earlier seed write) is to mock writeJson, which is why this test lives
  // alongside the compound-failure test instead of with the mutation
  // happy-path tests.
  let projectRoot: string;
  let patchesDir: string;

  beforeEach(async () => {
    projectRoot = await createTempProject('ff-mf-phase3-');
    patchesDir = join(projectRoot, 'patches');
    vi.clearAllMocks();
    // The compound-failure test above installs a stateful mockImplementation
    // that persists across `vi.clearAllMocks` (clearAllMocks resets call
    // history only, not the impl). Reinstall the real implementations on
    // both mocks so seed() below behaves normally and so this describe's
    // own writeJson override starts from a clean slate.
    const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
    vi.mocked(writeJson).mockImplementation(actual.writeJson);
    vi.mocked(removeFile).mockImplementation(actual.removeFile);
    await seed(patchesDir);
  });

  afterEach(async () => {
    await removeTempProject(projectRoot);
  });

  it('reverts completed final renames when the phase-3 manifest save fails', async () => {
    // Rename both seeded patches into clean slots (005/006) so phase 2
    // has no collision and can finish cleanly. Phase 3 then fails
    // because writeJson is mocked to throw.
    vi.mocked(writeJson).mockImplementation(() => {
      return Promise.reject(new Error('simulated manifest save failure'));
    });

    await expect(
      renumberPatchesInManifest(
        patchesDir,
        new Map([
          ['001-infra-a.patch', { newFilename: '005-infra-a.patch', newOrder: 5 }],
          ['002-infra-b.patch', { newFilename: '006-infra-b.patch', newOrder: 6 }],
        ])
      )
    ).rejects.toThrow('simulated manifest save failure');

    // Disk: files must be back at their ORIGINAL names. If the rollback
    // short-circuited, we would see 005/006 on disk and 001/002 missing.
    const entries = (await readdir(patchesDir)).filter((f) => f.endsWith('.patch')).sort();
    expect(entries).toEqual(['001-infra-a.patch', '002-infra-b.patch']);
    expect(await readFile(join(patchesDir, '001-infra-a.patch'), 'utf-8')).toBe('a');
    expect(await readFile(join(patchesDir, '002-infra-b.patch'), 'utf-8')).toBe('b');

    // No staging residue.
    const staging = (await readdir(patchesDir)).filter((f) => f.startsWith('.fireforge-renumber-'));
    expect(staging).toEqual([]);

    // Manifest: the save failed before it could land, so the on-disk
    // manifest must still be the pre-operation state. Restore writeJson
    // so loadPatchesManifest (which reads but does not write) isn't
    // tainted by the mock on subsequent file operations in the test
    // harness.
    const actual = await vi.importActual<typeof import('../../utils/fs.js')>('../../utils/fs.js');
    vi.mocked(writeJson).mockImplementation(actual.writeJson);

    const onDiskManifest = JSON.parse(
      await readFile(join(patchesDir, 'patches.json'), 'utf-8')
    ) as PatchesManifest;
    expect(onDiskManifest.patches.map((p) => p.filename)).toEqual([
      '001-infra-a.patch',
      '002-infra-b.patch',
    ]);
    expect(onDiskManifest.patches.map((p) => p.order)).toEqual([1, 2]);
  });
});
