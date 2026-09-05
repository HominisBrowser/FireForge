// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../patch-apply.js', () => ({
  discoverPatches: vi.fn(),
  withPatchDirectoryLock: vi.fn((_patchesDir: string, operation: () => unknown) =>
    Promise.resolve(operation())
  ),
}));

vi.mock('../patch-manifest.js', () => ({
  PATCHES_MANIFEST: 'patches.json',
  loadPatchesManifest: vi.fn(),
  loadPatchesManifestForWrite: vi.fn(),
  mutatePatchRowsInManifest: vi.fn(),
  savePatchesManifest: vi.fn(),
  addPatchToManifest: vi.fn(),
  findPatchesAffectingFile: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(),
  };
});

import { unlink } from 'node:fs/promises';

import { nativePath } from '../../test-utils/index.js';
import { pathExists, readText, removeFile, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { discoverPatches } from '../patch-apply.js';
import {
  commitExportedPatch,
  getNextPatchFilename,
  getNextPatchNumber,
  updatePatchAndMetadata,
} from '../patch-export.js';
import {
  addPatchToManifest,
  loadPatchesManifest,
  loadPatchesManifestForWrite,
  mutatePatchRowsInManifest,
  savePatchesManifest,
} from '../patch-manifest.js';

describe('patch-export rollback and supersede paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverPatches).mockResolvedValue([]);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(writeText).mockResolvedValue(undefined);
    vi.mocked(removeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    // The write paths use the ForWrite loader (corrupt-aborting). These
    // unit fixtures never simulate corruption, so it mirrors the reader.
    vi.mocked(loadPatchesManifestForWrite).mockImplementation((dir: string) =>
      vi.mocked(loadPatchesManifest)(dir)
    );
    vi.mocked(mutatePatchRowsInManifest).mockResolvedValue([]);
    vi.mocked(savePatchesManifest).mockResolvedValue(undefined);
    vi.mocked(addPatchToManifest).mockResolvedValue(undefined);
  });

  it('rolls back commit state when manifest update fails', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: nativePath('/patches/001-ui-old.patch') },
    ] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === nativePath('/patches/001-ui-old.patch'))
    );
    vi.mocked(readText).mockResolvedValueOnce('old patch');
    vi.mocked(addPatchToManifest).mockRejectedValueOnce(new Error('manifest exploded'));

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'new patch',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['browser/base/content/browser.js'],
      })
    ).rejects.toThrow('manifest exploded');

    expect(writeText).toHaveBeenCalledWith(nativePath('/patches/001-ui-dock.patch'), 'new patch');
    expect(removeFile).toHaveBeenCalledWith(nativePath('/patches/001-ui-dock.patch'));
    expect(writeText).toHaveBeenCalledWith(nativePath('/patches/001-ui-old.patch'), 'old patch');
    expect(savePatchesManifest).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses updatePatchAndMetadata when patches.json is missing or the patch file is absent', async () => {
    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '001-ui-old.patch',
        newContent: 'new body',
        updates: { description: 'new' },
      })
    ).rejects.toThrow(/patches\.json is missing/);

    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '001-ui-old.patch',
        newContent: 'new body',
        updates: { description: 'new' },
      })
    ).rejects.toThrow(/patch file is missing on disk/);
  });

  it('allocates patch numbers and filenames from finite patch orders only', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: 'legacy.patch', path: '/patches/legacy.patch', order: Number.NaN },
      { filename: '002-ui-real.patch', path: '/patches/002-ui-real.patch', order: 2 },
    ] as never);
    await expect(getNextPatchNumber('/patches')).resolves.toBe('003');
    await expect(getNextPatchFilename('/patches', 'ui', 'Dock Panel')).resolves.toBe(
      '003-ui-dock-panel.patch'
    );

    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '999-ui-big.patch', path: '/patches/999-ui-big.patch', order: 999 },
    ] as never);
    await expect(getNextPatchNumber('/patches')).resolves.toBe('1000');

    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: 'legacy.patch', path: '/patches/legacy.patch', order: Number.POSITIVE_INFINITY },
    ] as never);
    await expect(getNextPatchNumber('/patches')).resolves.toBe('001');
  });

  it('removes superseded patch files after a successful commit', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: nativePath('/patches/001-ui-old.patch') },
    ] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === nativePath('/patches/001-ui-old.patch'))
    );

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'new patch',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['browser/base/content/browser.js'],
      })
    ).resolves.toEqual(
      expect.objectContaining({
        superseded: [
          { filename: '001-ui-old.patch', path: nativePath('/patches/001-ui-old.patch') },
        ],
      })
    );

    expect(removeFile).toHaveBeenCalledWith(nativePath('/patches/001-ui-old.patch'));
  });

  it('commitExportedPatch backs up existing patch content and restores it on rollback', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [],
    } as never);
    // The new patch path already exists on disk
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('pre-existing content');
    vi.mocked(addPatchToManifest).mockRejectedValueOnce(new Error('write failed'));

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'new diff',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.js'],
      })
    ).rejects.toThrow('write failed');

    // Rollback should restore original content, not delete the file
    expect(writeText).toHaveBeenCalledWith(
      nativePath('/patches/001-ui-dock.patch'),
      'pre-existing content'
    );
  });

  it('commitExportedPatch rollback removes manifest file when no manifest existed before', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(addPatchToManifest).mockRejectedValueOnce(new Error('boom'));

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'diff',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.js'],
      })
    ).rejects.toThrow('boom');

    // With no prior manifest, rollback should remove the manifest file
    expect(removeFile).toHaveBeenCalledWith(nativePath('/patches/patches.json'));
  });

  it('commitExportedPatch skips backup for superseded patches missing on disk', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: nativePath('/patches/001-ui-old.patch') },
    ] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    // Superseded patch does not exist on disk
    vi.mocked(pathExists).mockResolvedValue(false);

    const result = await commitExportedPatch({
      patchesDir: '/patches',
      category: 'ui',
      name: 'dock',
      description: 'Dock',
      diff: 'new diff',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: ['a.js'],
    });

    expect(result.superseded).toHaveLength(1);
    // readText should not have been called for the superseded patch backup
    expect(readText).not.toHaveBeenCalledWith(nativePath('/patches/001-ui-old.patch'));
  });

  it('commitExportedPatch warns when rollback itself fails', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [],
    } as never);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(writeText).mockResolvedValueOnce(undefined); // patch write succeeds
    vi.mocked(addPatchToManifest).mockRejectedValueOnce(new Error('manifest fail'));
    // Rollback removeFile also fails
    vi.mocked(removeFile).mockRejectedValueOnce(new Error('rm fail'));
    // Manifest rollback also fails
    vi.mocked(savePatchesManifest).mockRejectedValueOnce(new Error('save fail'));

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'diff',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.js'],
      })
    ).rejects.toThrow('manifest fail');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not restore patch file'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not restore manifest'));
  });

  it('updatePatchAndMetadata throws when filename is not in manifest', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);

    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '999-ui-missing.patch',
        newContent: 'body',
        updates: { description: 'new' },
      })
    ).rejects.toThrow(/not found in patches\.json/);
  });

  it('updatePatchAndMetadata works without onCommitted hook', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('old body');

    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '001-ui-old.patch',
        newContent: 'new body',
        updates: { description: 'updated' },
      })
    ).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith(nativePath('/patches/001-ui-old.patch'), 'new body');
    expect(mutatePatchRowsInManifest).toHaveBeenCalledWith(
      '/patches',
      ['001-ui-old.patch'],
      expect.any(Function)
    );
  });

  it('updatePatchAndMetadata rolls back patch on manifest save failure', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('original body');
    vi.mocked(writeText).mockResolvedValueOnce(undefined); // patch write OK
    vi.mocked(mutatePatchRowsInManifest).mockRejectedValueOnce(new Error('manifest save fail'));

    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '001-ui-old.patch',
        newContent: 'new body',
        updates: { description: 'new' },
      })
    ).rejects.toThrow('manifest save fail');

    // Should have attempted rollback of patch content
    expect(writeText).toHaveBeenCalledWith(
      nativePath('/patches/001-ui-old.patch'),
      'original body'
    );
  });

  it('updatePatchAndMetadata warns when rollback of patch content fails', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-old.patch',
          order: 1,
          category: 'ui',
          name: 'old',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('original body');
    vi.mocked(writeText)
      .mockResolvedValueOnce(undefined) // patch write OK
      .mockRejectedValueOnce(new Error('rollback fail')); // rollback write fails
    vi.mocked(mutatePatchRowsInManifest).mockRejectedValueOnce(new Error('manifest fail'));

    await expect(
      updatePatchAndMetadata({
        patchesDir: '/patches',
        filename: '001-ui-old.patch',
        newContent: 'new body',
        updates: { description: 'new' },
      })
    ).rejects.toThrow('manifest fail');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rollback warning'));
  });
});
