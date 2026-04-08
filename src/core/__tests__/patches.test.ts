// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import {
  pathExists,
  readJson,
  readText,
  removeFile,
  writeJson,
  writeText,
} from '../../utils/fs.js';
import { applyPatchToContent, extractNewFileContent } from '../patch-apply.js';
import { deletePatch, findAllPatchesForFiles, isPatchFullyCovered } from '../patch-export.js';
import { getClaimedFiles } from '../patch-manifest.js';

vi.mock('../patch-apply.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../patch-apply.js')>();
  return {
    ...actual,
    withPatchDirectoryLock: vi.fn((_patchesDir: string, operation: () => unknown) =>
      Promise.resolve(operation())
    ),
  };
});

vi.mock('../../utils/fs.js', () => ({
  readText: vi.fn(),
  writeText: vi.fn(),
  pathExists: vi.fn(),
  readJson: vi.fn(),
  writeJson: vi.fn(),
  removeFile: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  warn: vi.fn(),
}));

import { warn } from '../../utils/logger.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
    unlink: vi.fn(),
  };
});

import { readdir, unlink } from 'node:fs/promises';

const mockedPathExists = vi.mocked(pathExists);
const mockedReadJson = vi.mocked(readJson);
const mockedReadText = vi.mocked(readText);
const mockedRemoveFile = vi.mocked(removeFile);
const mockedReaddir = vi.mocked(readdir);
const mockedUnlink = vi.mocked(unlink);
const mockedWriteJson = vi.mocked(writeJson);
const mockedWriteText = vi.mocked(writeText);

beforeEach(() => {
  vi.clearAllMocks();
  mockedWriteJson.mockResolvedValue(undefined);
  mockedWriteText.mockResolvedValue(undefined);
  mockedRemoveFile.mockResolvedValue(undefined);
  mockedUnlink.mockResolvedValue(undefined);
});

function makePatch(filename: string, filesAffected: string[]): PatchMetadata {
  return {
    filename,
    order: parseInt(filename.split('-')[0] ?? '0', 10),
    category: 'ui' as const,
    name: 'test',
    description: '',
    createdAt: '',
    sourceEsrVersion: '140.0esr',
    filesAffected,
  };
}

describe('getClaimedFiles', () => {
  it('should return files from all patches except the excluded one', () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makePatch('001-ui-a.patch', ['file1.js', 'file2.js']),
        makePatch('002-ui-b.patch', ['file3.js']),
      ],
    };

    const claimed = getClaimedFiles(manifest, '001-ui-a.patch');
    expect(claimed).toEqual(new Set(['file3.js']));
    expect(claimed.has('file1.js')).toBe(false);
    expect(claimed.has('file2.js')).toBe(false);
  });

  it('should return empty set when only one patch exists', () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [makePatch('001-ui-a.patch', ['file1.js'])],
    };

    const claimed = getClaimedFiles(manifest, '001-ui-a.patch');
    expect(claimed.size).toBe(0);
  });

  it('should include all files from all non-excluded patches', () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makePatch('001-ui-a.patch', ['a.js']),
        makePatch('002-ui-b.patch', ['b.js', 'c.js']),
        makePatch('003-ui-c.patch', ['d.js']),
      ],
    };

    const claimed = getClaimedFiles(manifest, '002-ui-b.patch');
    expect(claimed).toEqual(new Set(['a.js', 'd.js']));
  });

  it('should handle overlapping files across patches', () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makePatch('001-ui-a.patch', ['shared.js', 'a.js']),
        makePatch('002-ui-b.patch', ['shared.js', 'b.js']),
      ],
    };

    const claimed = getClaimedFiles(manifest, '001-ui-a.patch');
    expect(claimed).toEqual(new Set(['shared.js', 'b.js']));
  });
});

describe('extractNewFileContent', () => {
  const SINGLE_FILE_PATCH = [
    'diff --git a/modules/Foo.sys.mjs b/modules/Foo.sys.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/modules/Foo.sys.mjs',
    '@@ -0,0 +1,3 @@',
    '+// Foo module',
    '+export const Foo = 1;',
    '+export default Foo;',
    '',
  ].join('\n');

  const MULTI_FILE_PATCH = [
    'diff --git a/modules/Alpha.sys.mjs b/modules/Alpha.sys.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/modules/Alpha.sys.mjs',
    '@@ -0,0 +1,2 @@',
    '+// Alpha',
    '+export const Alpha = "a";',
    'diff --git a/modules/Beta.sys.mjs b/modules/Beta.sys.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/modules/Beta.sys.mjs',
    '@@ -0,0 +1,2 @@',
    '+// Beta',
    '+export const Beta = "b";',
    'diff --git a/modules/Gamma.sys.mjs b/modules/Gamma.sys.mjs',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/modules/Gamma.sys.mjs',
    '@@ -0,0 +1,2 @@',
    '+// Gamma',
    '+export const Gamma = "g";',
    '',
  ].join('\n');

  it('extracts content from a single-file patch without targetFile', async () => {
    mockedReadText.mockResolvedValue(SINGLE_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch');

    expect(result).toBe('// Foo module\nexport const Foo = 1;\nexport default Foo;\n');
  });

  it('extracts content from a single-file patch with targetFile', async () => {
    mockedReadText.mockResolvedValue(SINGLE_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch', 'modules/Foo.sys.mjs');

    expect(result).toBe('// Foo module\nexport const Foo = 1;\nexport default Foo;\n');
  });

  it('extracts only the first file from a multi-file patch when targetFile specified', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch', 'modules/Alpha.sys.mjs');

    expect(result).toBe('// Alpha\nexport const Alpha = "a";\n');
  });

  it('extracts only the second file from a multi-file patch when targetFile specified', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch', 'modules/Beta.sys.mjs');

    expect(result).toBe('// Beta\nexport const Beta = "b";\n');
  });

  it('extracts only the last file from a multi-file patch when targetFile specified', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch', 'modules/Gamma.sys.mjs');

    expect(result).toBe('// Gamma\nexport const Gamma = "g";\n');
  });

  it('returns empty content for a non-existent target file in a multi-file patch', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch', 'modules/NotHere.sys.mjs');

    expect(result).toBe('\n');
  });

  it('without targetFile, extracts all files concatenated (legacy behavior)', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_PATCH);

    const result = await extractNewFileContent('/fake/patch.patch');

    // Without targetFile, all + lines from all hunks are concatenated
    expect(result).toContain('Alpha');
    expect(result).toContain('Beta');
    expect(result).toContain('Gamma');
  });
});

describe('isPatchFullyCovered', () => {
  it('returns true when a new export exactly matches an existing patch', () => {
    expect(isPatchFullyCovered(['a.js', 'b.js'], ['a.js', 'b.js'])).toBe(true);
  });

  it('returns false when a new export only partially overlaps an existing patch', () => {
    expect(isPatchFullyCovered(['a.js', 'b.js'], ['a.js'])).toBe(false);
  });

  it('returns true when target is a superset of the patch files', () => {
    expect(isPatchFullyCovered(['a.js'], ['a.js', 'b.js'])).toBe(true);
  });

  it('returns true for a single-file patch covered by target', () => {
    expect(isPatchFullyCovered(['a.js'], ['a.js'])).toBe(true);
  });

  it('returns false when patch files is empty', () => {
    expect(isPatchFullyCovered([], ['a.js'])).toBe(false);
  });

  it('returns false when target files is empty', () => {
    expect(isPatchFullyCovered(['a.js'], [])).toBe(false);
  });

  it('returns false when both arrays are empty', () => {
    expect(isPatchFullyCovered([], [])).toBe(false);
  });
});

describe('findAllPatchesForFiles', () => {
  it('returns fully covered patches and preserves partial overlaps', async () => {
    const manifest: PatchesManifest = {
      version: 1,
      patches: [
        makePatch('001-ui-a.patch', ['a.js']),
        makePatch('002-ui-ab.patch', ['a.js', 'b.js']),
        makePatch('003-ui-c.patch', ['c.js']),
      ],
    };

    mockedPathExists.mockResolvedValue(true);
    mockedReadJson.mockResolvedValue(manifest);
    mockedReaddir.mockResolvedValue([
      { name: '001-ui-a.patch', isFile: () => true },
      { name: '002-ui-ab.patch', isFile: () => true },
      { name: '003-ui-c.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const superseded = await findAllPatchesForFiles('/fake/patches', ['a.js', 'c.js']);

    expect(superseded.map((patch) => patch.filename)).toEqual(['001-ui-a.patch', '003-ui-c.patch']);
  });
});

describe('deletePatch', () => {
  const manifest: PatchesManifest = {
    version: 1,
    patches: [makePatch('001-ui-a.patch', ['a.js']), makePatch('002-ui-b.patch', ['b.js'])],
  };

  it('updates the manifest before deleting the patch file', async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedReadJson.mockResolvedValue(manifest);

    await deletePatch('/fake/patches', '001-ui-a.patch');

    expect(mockedWriteJson).toHaveBeenCalledWith('/fake/patches/patches.json', {
      version: 1,
      patches: [makePatch('002-ui-b.patch', ['b.js'])],
    });
    expect(mockedUnlink).toHaveBeenCalledWith('/fake/patches/001-ui-a.patch');
  });

  it('does not delete the patch file if manifest persistence fails', async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedReadJson.mockResolvedValue(manifest);
    mockedWriteJson.mockRejectedValue(new Error('manifest write failed'));

    await expect(deletePatch('/fake/patches', '001-ui-a.patch')).rejects.toThrow(
      'manifest write failed'
    );
    expect(mockedUnlink).not.toHaveBeenCalled();
  });

  it('restores the manifest if file deletion fails', async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedReadJson.mockResolvedValue(manifest);
    mockedUnlink.mockRejectedValue(new Error('unlink failed'));

    await expect(deletePatch('/fake/patches', '001-ui-a.patch')).rejects.toThrow('unlink failed');

    expect(mockedWriteJson).toHaveBeenNthCalledWith(1, '/fake/patches/patches.json', {
      version: 1,
      patches: [makePatch('002-ui-b.patch', ['b.js'])],
    });
    expect(mockedWriteJson).toHaveBeenNthCalledWith(2, '/fake/patches/patches.json', manifest);
  });

  it('warns and throws the original error when both unlink and manifest rollback fail', async () => {
    mockedPathExists.mockResolvedValue(true);
    mockedReadJson.mockResolvedValue(manifest);
    mockedUnlink.mockRejectedValue(new Error('unlink failed'));
    mockedWriteJson
      .mockResolvedValueOnce(undefined) // initial manifest update succeeds
      .mockRejectedValueOnce(new Error('rollback failed')); // rollback fails

    await expect(deletePatch('/fake/patches', '001-ui-a.patch')).rejects.toThrow('unlink failed');

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to restore manifest after patch deletion error')
    );
  });
});

describe('applyPatchToContent (multi-file patch)', () => {
  const MULTI_FILE_MODIFY_PATCH = [
    'diff --git a/file-a.js b/file-a.js',
    '--- a/file-a.js',
    '+++ b/file-a.js',
    '@@ -1,3 +1,3 @@',
    ' line1',
    '-line2',
    '+line2-modified',
    ' line3',
    'diff --git a/file-b.js b/file-b.js',
    '--- a/file-b.js',
    '+++ b/file-b.js',
    '@@ -1,3 +1,3 @@',
    ' alpha',
    '-beta',
    '+beta-modified',
    ' gamma',
    '',
  ].join('\n');

  it('applies hunks for the first file in a multi-file patch', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_MODIFY_PATCH);

    const result = await applyPatchToContent(
      'line1\nline2\nline3\n',
      '/fake/patch.patch',
      'file-a.js'
    );

    expect(result).toBe('line1\nline2-modified\nline3\n');
  });

  it('applies hunks for the second file in a multi-file patch', async () => {
    mockedReadText.mockResolvedValue(MULTI_FILE_MODIFY_PATCH);

    const result = await applyPatchToContent(
      'alpha\nbeta\ngamma\n',
      '/fake/patch.patch',
      'file-b.js'
    );

    expect(result).toBe('alpha\nbeta-modified\ngamma\n');
  });
});

describe('applyPatchToContent — multi-hunk in single file', () => {
  it('applies two non-overlapping hunks in the same file', async () => {
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
      '@@ -5,3 +5,3 @@',
      ' line5',
      '-line6',
      '+line6-modified',
      ' line7',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\n';
    const result = await applyPatchToContent(content, '/fake/patch.patch', 'app.js');

    expect(result).toBe('line1\nline2-modified\nline3\nline4\nline5\nline6-modified\nline7\n');
  });

  it('applies hunks in reverse order to preserve line numbers', async () => {
    // Second hunk adds a line, which would shift the first hunk if applied first
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,2 +1,2 @@',
      '-line1',
      '+line1-modified',
      ' line2',
      '@@ -4,2 +4,3 @@',
      ' line4',
      '-line5',
      '+line5a',
      '+line5b',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\nline3\nline4\nline5\n';
    const result = await applyPatchToContent(content, '/fake/patch.patch', 'app.js');

    expect(result).toBe('line1-modified\nline2\nline3\nline4\nline5a\nline5b\n');
  });

  it('throws on context mismatch', async () => {
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-WRONG',
      '+replacement',
      ' line3',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\nline3\n';
    await expect(applyPatchToContent(content, '/fake/patch.patch', 'app.js')).rejects.toThrow(
      'context mismatch'
    );
  });
});

describe('applyPatchToContent — no-newline-at-end-of-file', () => {
  it('omits trailing newline when patch has no-newline marker', async () => {
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      '\\ No newline at end of file',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\n';
    const result = await applyPatchToContent(content, '/fake/patch.patch', 'app.js');

    expect(result).toBe('line1\nline2-modified');
  });

  it('adds trailing newline when patch does not have no-newline marker', async () => {
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\n';
    const result = await applyPatchToContent(content, '/fake/patch.patch', 'app.js');

    expect(result).toBe('line1\nline2-modified\n');
  });
});

describe('applyPatchToContent — hunk header mismatch', () => {
  it('throws when hunk header count does not match body', async () => {
    // Header says 3 old lines but body only has 2
    const patch = [
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,3 +1,2 @@',
      ' line1',
      '-line2',
      '',
    ].join('\n');

    mockedReadText.mockResolvedValue(patch);

    const content = 'line1\nline2\nline3\n';
    await expect(applyPatchToContent(content, '/fake/patch.patch', 'app.js')).rejects.toThrow(
      'header mismatch'
    );
  });
});
