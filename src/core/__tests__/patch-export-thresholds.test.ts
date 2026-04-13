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
  findAllPatchesForFiles,
  findExistingPatchForFile,
  findSupersededPatches,
  getNextPatchFilename,
  getNextPatchNumber,
  isPatchFullyCovered,
  parseFilename,
  planExport,
  updatePatchAndMetadata,
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
          sourceEsrVersion: '140.9.0esr',
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
        sourceEsrVersion: '140.9.0esr',
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
          sourceEsrVersion: '140.9.0esr',
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

  it('refuses updatePatchAndMetadata when patches.json is missing or the patch file is absent', async () => {
    await expect(
      updatePatchAndMetadata('/patches', '001-ui-old.patch', 'new body', { description: 'new' })
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
      updatePatchAndMetadata('/patches', '001-ui-old.patch', 'new body', { description: 'new' })
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
  });

  it('parses new-format, legacy, and invalid patch filenames', () => {
    expect(parseFilename('001-ui-sidebar.patch')).toEqual({
      order: 1,
      category: 'ui',
      name: 'sidebar',
    });
    expect(parseFilename('002-sidebar.patch')).toEqual({
      order: 2,
      category: null,
      name: 'sidebar',
    });
    expect(parseFilename('garbage')).toEqual({
      order: Number.POSITIVE_INFINITY,
      category: null,
      name: 'garbage',
    });
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
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
        {
          filename: '002-ui-other.patch',
          order: 2,
          category: 'ui',
          name: 'other',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
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
          sourceEsrVersion: '140.9.0esr',
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
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['browser/base/content/browser.js'],
      })
    ).resolves.toEqual(
      expect.objectContaining({
        superseded: [{ filename: '001-ui-old.patch', path: '/patches/001-ui-old.patch' }],
      })
    );

    expect(removeFile).toHaveBeenCalledWith('/patches/001-ui-old.patch');
  });

  it('plans an export even when there is no existing manifest', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([] as never);
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);

    const plan = await planExport({
      patchesDir: '/patches',
      category: 'ui',
      name: 'dock',
      description: 'Dock',
      filesAffected: ['browser/base/content/browser.js'],
      sourceEsrVersion: '140.9.0esr',
    });

    expect(plan.patchFilename).toBe('001-ui-dock.patch');
    expect(plan.manifestBefore).toBeNull();
    expect(plan.manifestAfter.patches[0]?.filename).toBe('001-ui-dock.patch');
  });

  it('returns early when deleting a patch whose file is already gone', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue({ version: 1, patches: [] } as never);
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(deletePatch('/patches', '001-ui-old.patch')).resolves.toBeUndefined();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('parses a filename with valid format but invalid category as legacy', () => {
    // Regex matches 001-xyz-name.patch but "xyz" is not in PATCH_CATEGORIES
    const result = parseFilename('001-xyz-sidebar.patch');
    expect(result).toEqual({ order: 1, category: null, name: 'xyz-sidebar' });
  });

  it('isPatchFullyCovered returns false for empty patchFiles', () => {
    expect(isPatchFullyCovered([], ['a.js'])).toEqual({ covered: false, byFiles: [] });
  });

  it('isPatchFullyCovered returns byFiles when fully covered', () => {
    expect(isPatchFullyCovered(['a.js', 'b.js'], ['a.js', 'b.js', 'c.js'])).toEqual({
      covered: true,
      byFiles: ['a.js', 'b.js'],
    });
  });

  it('isPatchFullyCovered returns empty byFiles when not fully covered', () => {
    expect(isPatchFullyCovered(['a.js', 'b.js'], ['a.js'])).toEqual({
      covered: false,
      byFiles: [],
    });
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
    expect(writeText).toHaveBeenCalledWith('/patches/001-ui-dock.patch', 'pre-existing content');
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
    expect(removeFile).toHaveBeenCalledWith('/patches/patches.json');
  });

  it('commitExportedPatch skips backup for superseded patches missing on disk', async () => {
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
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    // Superseded patch does NOT exist on disk
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
    // readText should NOT have been called for the superseded patch backup
    expect(readText).not.toHaveBeenCalledWith('/patches/001-ui-old.patch');
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
      updatePatchAndMetadata('/patches', '999-ui-missing.patch', 'body', { description: 'new' })
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
      updatePatchAndMetadata('/patches', '001-ui-old.patch', 'new body', { description: 'updated' })
    ).resolves.toBeUndefined();

    expect(writeText).toHaveBeenCalledWith('/patches/001-ui-old.patch', 'new body');
    expect(savePatchesManifest).toHaveBeenCalled();
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
    vi.mocked(savePatchesManifest).mockRejectedValueOnce(new Error('manifest save fail'));

    await expect(
      updatePatchAndMetadata('/patches', '001-ui-old.patch', 'new body', { description: 'new' })
    ).rejects.toThrow('manifest save fail');

    // Should have attempted rollback of patch content
    expect(writeText).toHaveBeenCalledWith('/patches/001-ui-old.patch', 'original body');
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
    vi.mocked(savePatchesManifest).mockRejectedValueOnce(new Error('manifest fail'));

    await expect(
      updatePatchAndMetadata('/patches', '001-ui-old.patch', 'new body', { description: 'new' })
    ).rejects.toThrow('manifest fail');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Rollback warning'));
  });

  it('updatePatchMetadata returns early when entry is not found', async () => {
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
      updatePatchMetadata('/patches', '999-ui-missing.patch', { description: 'new' })
    ).resolves.toBeUndefined();

    expect(savePatchesManifest).not.toHaveBeenCalled();
  });

  it('findSupersededPatches returns empty when manifest is null', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    await expect(findSupersededPatches('/patches', ['a.js'])).resolves.toEqual([]);
  });

  it('findSupersededPatches skips multi-file patches and non-matching files', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-multi.patch',
          order: 1,
          category: 'ui',
          name: 'multi',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js', 'b.js'],
        },
        {
          filename: '002-ui-other.patch',
          order: 2,
          category: 'ui',
          name: 'other',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['c.js'],
        },
      ],
    } as never);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-multi.patch', path: '/patches/001-ui-multi.patch' },
      { filename: '002-ui-other.patch', path: '/patches/002-ui-other.patch' },
    ] as never);

    // Neither should be superseded: 001 is multi-file, 002 doesn't match
    await expect(findSupersededPatches('/patches', ['a.js'])).resolves.toEqual([]);
  });

  it('deletePatch successfully unlinks an existing file', async () => {
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
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(deletePatch('/patches', '001-ui-old.patch')).resolves.toBeUndefined();
    expect(savePatchesManifest).toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
  });

  it('deletePatch restores manifest when unlink fails', async () => {
    const manifest = {
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
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(unlink).mockRejectedValueOnce(new Error('unlink fail'));

    await expect(deletePatch('/patches', '001-ui-old.patch')).rejects.toThrow('unlink fail');
    // Should restore the original manifest
    expect(savePatchesManifest).toHaveBeenCalledTimes(2);
  });

  it('deletePatch warns when manifest restore fails after unlink failure', async () => {
    const manifest = {
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
    };
    vi.mocked(loadPatchesManifest).mockResolvedValue(manifest as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(unlink).mockRejectedValueOnce(new Error('unlink fail'));
    vi.mocked(savePatchesManifest)
      .mockResolvedValueOnce(undefined) // first save (filter) OK
      .mockRejectedValueOnce(new Error('restore fail')); // restore fails

    await expect(deletePatch('/patches', '001-ui-old.patch')).rejects.toThrow('unlink fail');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Failed to restore manifest'));
  });

  it('deletePatch handles null manifest gracefully', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(deletePatch('/patches', '001-ui-old.patch')).resolves.toBeUndefined();
    expect(savePatchesManifest).not.toHaveBeenCalled();
    expect(unlink).toHaveBeenCalled();
  });

  it('findAllPatchesForFiles returns empty when manifest is null', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    await expect(findAllPatchesForFiles('/patches', ['a.js'])).resolves.toEqual([]);
  });

  it('findAllPatchesForFiles finds fully covered patches and respects exclusions', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-a.patch',
          order: 1,
          category: 'ui',
          name: 'a',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
        {
          filename: '002-ui-b.patch',
          order: 2,
          category: 'ui',
          name: 'b',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['b.js', 'c.js'],
        },
      ],
    } as never);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-a.patch', path: '/patches/001-ui-a.patch' },
      { filename: '002-ui-b.patch', path: '/patches/002-ui-b.patch' },
    ] as never);

    // Only a.js is in target — 001 is covered, 002 is not (needs b.js+c.js)
    const result = await findAllPatchesForFiles('/patches', ['a.js']);
    expect(result).toEqual([{ filename: '001-ui-a.patch', path: '/patches/001-ui-a.patch' }]);

    // With exclusion of the matching patch
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-a.patch',
          order: 1,
          category: 'ui',
          name: 'a',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['a.js'],
        },
      ],
    } as never);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-a.patch', path: '/patches/001-ui-a.patch' },
    ] as never);

    const excluded = await findAllPatchesForFiles('/patches', ['a.js'], '001-ui-a.patch');
    expect(excluded).toEqual([]);
  });

  it('getNextPatchNumber pads numbers beyond 3 digits correctly', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '999-ui-big.patch', path: '/patches/999-ui-big.patch', order: 999 },
    ] as never);

    await expect(getNextPatchNumber('/patches')).resolves.toBe('1000');
  });

  it('getNextPatchNumber returns 001 when all patches have non-finite orders', async () => {
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: 'legacy.patch', path: '/patches/legacy.patch', order: Number.POSITIVE_INFINITY },
    ] as never);

    await expect(getNextPatchNumber('/patches')).resolves.toBe('001');
  });
});
