// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../patch-apply.js', () => ({
  discoverPatches: vi.fn(),
  isNewFilePatch: vi.fn(),
  withPatchDirectoryLock: vi.fn((_patchesDir: string, operation: () => unknown) =>
    Promise.resolve(operation())
  ),
}));

vi.mock('../patch-manifest.js', () => ({
  PATCHES_MANIFEST: 'patches.json',
  loadPatchesManifest: vi.fn(),
  savePatchesManifest: vi.fn(),
  addPatchToManifest: vi.fn(),
  findPatchesAffectingFile: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
  removeFile: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    unlink: vi.fn(),
  };
});

import { unlink } from 'node:fs/promises';

import { pathExists, readText, removeFile, writeText } from '../../utils/fs.js';
import { warn } from '../../utils/logger.js';
import { discoverPatches, isNewFilePatch } from '../patch-apply.js';
import {
  commitExportedPatch,
  deletePatch,
  findExistingPatchForFile,
  findSupersededPatches,
  updatePatchMetadata,
} from '../patch-export.js';
import {
  addPatchToManifest,
  findPatchesAffectingFile,
  loadPatchesManifest,
  savePatchesManifest,
} from '../patch-manifest.js';

describe('patch-export threshold coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverPatches).mockResolvedValue([]);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(writeText).mockResolvedValue(undefined);
    vi.mocked(removeFile).mockResolvedValue(undefined);
    vi.mocked(unlink).mockResolvedValue(undefined);
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    vi.mocked(savePatchesManifest).mockResolvedValue(undefined);
    vi.mocked(addPatchToManifest).mockResolvedValue(undefined);
    vi.mocked(findPatchesAffectingFile).mockResolvedValue([]);
  });

  it('rolls back commit state when manifest update fails', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' },
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
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === '/patches/001-ui-old.patch')
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
        sourceEsrVersion: '140.0esr',
        filesAffected: ['browser/base/content/browser.js'],
      })
    ).rejects.toThrow('manifest exploded');

    expect(writeText).toHaveBeenCalledWith('/patches/001-ui-dock.patch', 'new patch');
    expect(removeFile).toHaveBeenCalledWith('/patches/001-ui-dock.patch');
    expect(writeText).toHaveBeenCalledWith('/patches/001-ui-old.patch', 'old patch');
    expect(savePatchesManifest).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the most recent patch affecting a file', async () => {
    vi.mocked(findPatchesAffectingFile).mockResolvedValue([
      {
        patch: { filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' },
        metadata: { filename: '001-ui-old.patch', order: 1 },
      },
      {
        patch: { filename: '002-ui-new.patch', path: '/patches/002-ui-new.patch' },
        metadata: { filename: '002-ui-new.patch', order: 2 },
      },
    ] as never);

    const existingPatch = await findExistingPatchForFile(
      '/patches',
      'browser/base/content/browser.js'
    );
    expect(existingPatch?.patch.filename).toBe('002-ui-new.patch');

    const repeatedLookup = await findExistingPatchForFile('/patches', 'missing.js');
    expect(repeatedLookup?.patch.filename).toBe('002-ui-new.patch');

    vi.mocked(findPatchesAffectingFile).mockResolvedValueOnce([]);
    await expect(findExistingPatchForFile('/patches', 'missing.js')).resolves.toBeNull();
  });

  it('updates metadata only when the manifest and patch entry exist', async () => {
    await expect(
      updatePatchMetadata('/patches', '001-ui-old.patch', { description: 'new' })
    ).resolves.toBeUndefined();

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
          sourceEsrVersion: '140.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);

    await expect(
      updatePatchMetadata('/patches', '001-ui-old.patch', { description: 'new' })
    ).resolves.toBeUndefined();
    expect(savePatchesManifest).toHaveBeenCalledWith(
      '/patches',
      expect.objectContaining({
        patches: [expect.objectContaining({ description: 'new' })],
      })
    );
  });

  it('finds superseded single-file new-file patches and respects exclusions', async () => {
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
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
        {
          filename: '002-ui-other.patch',
          order: 2,
          category: 'ui',
          name: 'other',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/components/preferences/main.js'],
        },
      ],
    } as never);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' },
      { filename: '002-ui-other.patch', path: '/patches/002-ui-other.patch' },
    ] as never);
    vi.mocked(isNewFilePatch).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === '/patches/001-ui-old.patch')
    );

    await expect(
      findSupersededPatches('/patches', ['browser/base/content/browser.js'], '002-ui-other.patch')
    ).resolves.toEqual([{ filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' }]);
  });

  it('removes superseded patch files after a successful commit', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' },
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
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    } as never);
    vi.mocked(pathExists).mockImplementation((filePath: string) =>
      Promise.resolve(filePath === '/patches/001-ui-old.patch')
    );

    await expect(
      commitExportedPatch({
        patchesDir: '/patches',
        category: 'ui',
        name: 'dock',
        description: 'Dock',
        diff: 'new patch',
        sourceEsrVersion: '140.0esr',
        filesAffected: ['browser/base/content/browser.js'],
      })
    ).resolves.toEqual(
      expect.objectContaining({
        superseded: [{ filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' }],
      })
    );

    expect(removeFile).toHaveBeenCalledWith('/patches/001-ui-old.patch');
  });

  it('returns early when deleting a patch whose file is already gone', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue({ version: 1, patches: [] } as never);
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(deletePatch('/patches', '001-ui-old.patch')).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
  });
});
