// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../git.js', () => ({
  applyPatchIdempotent: vi.fn(),
  reversePatch: vi.fn(),
}));

vi.mock('../git-file-ops.js', () => ({
  getFileContentFromHead: vi.fn(),
}));

vi.mock('../patch-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../patch-manifest.js')>();
  return {
    ...actual,
    findPatchesAffectingFile: vi.fn(),
  };
});

vi.mock('../patch-parse.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../patch-parse.js')>();
  return {
    ...actual,
    extractAffectedFiles: vi.fn(),
    extractConflictingFiles: vi.fn(),
  };
});

vi.mock('../patch-transform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../patch-transform.js')>();
  return {
    ...actual,
    applyPatchToContent: vi.fn(),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

import { readdir } from 'node:fs/promises';

import { pathExists, readText, writeText } from '../../utils/fs.js';
import { exec } from '../../utils/process.js';
import { applyPatchIdempotent, reversePatch } from '../git.js';
import { getFileContentFromHead } from '../git-file-ops.js';
import {
  applyPatches,
  applyPatchesWithContinue,
  computePatchedContent,
  countPatches,
  discoverPatches,
  getAllTargetFilesFromPatch,
  getTargetFileFromPatch,
  isNewFilePatch,
  validatePatches,
} from '../patch-apply.js';
import { findPatchesAffectingFile } from '../patch-manifest.js';
import { extractAffectedFiles, extractConflictingFiles } from '../patch-parse.js';
import { applyPatchToContent } from '../patch-transform.js';

describe('patch orchestration helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
  });

  it('returns no patches when the directory does not exist', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(discoverPatches('/patches')).resolves.toEqual([]);
    await expect(countPatches('/patches')).resolves.toBe(0);
    expect(readdir).not.toHaveBeenCalled();
  });

  it('discovers and sorts patch files by numeric order then filename', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '010-zebra.patch', isFile: () => true },
      { name: '001-bravo.patch', isFile: () => true },
      { name: 'README.md', isFile: () => true },
      { name: '001-alpha.patch', isFile: () => true },
      { name: 'nested', isFile: () => false },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    const patches = await discoverPatches('/patches');

    expect(patches).toEqual([
      { path: '/patches/001-alpha.patch', filename: '001-alpha.patch', order: 1 },
      { path: '/patches/001-bravo.patch', filename: '001-bravo.patch', order: 1 },
      { path: '/patches/010-zebra.patch', filename: '010-zebra.patch', order: 10 },
    ]);
    await expect(countPatches('/patches')).resolves.toBe(3);
  });

  it('parses target file helpers from patch content', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/foo.js b/foo.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/foo.js',
        '@@ -0,0 +1 @@',
        '+first',
        'diff --git a/bar.css b/bar.css',
        '--- a/bar.css',
        '+++ b/bar.css',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')
    );

    await expect(isNewFilePatch('/patches/001-foo.patch')).resolves.toBe(true);
    await expect(getTargetFileFromPatch('/patches/001-foo.patch')).resolves.toBe('foo.js');
    await expect(getAllTargetFilesFromPatch('/patches/001-foo.patch')).resolves.toEqual([
      'foo.js',
      'bar.css',
    ]);
  });

  it('aggregates git apply check failures during validation', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'patch does not apply' });

    const result = await validatePatches('/patches', '/engine');

    expect(exec).toHaveBeenNthCalledWith(
      1,
      'git',
      ['apply', '--check', '--', '/patches/001-alpha.patch'],
      {
        cwd: '/engine',
      }
    );
    expect(exec).toHaveBeenNthCalledWith(
      2,
      'git',
      ['apply', '--check', '--', '/patches/002-beta.patch'],
      {
        cwd: '/engine',
      }
    );
    expect(result).toEqual({
      valid: false,
      errors: ['002-beta.patch: patch does not apply'],
    });
  });

  it('returns a valid result when all patches pass git apply check', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(exec)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await expect(validatePatches('/patches', '/engine')).resolves.toEqual({
      valid: true,
      errors: [],
    });
  });

  it('rejects patch paths that escape engine/ during validation', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/../../etc/passwd b/../../etc/passwd',
        '--- a/../../etc/passwd',
        '+++ b/../../etc/passwd',
      ].join('\n')
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['../../etc/passwd']);

    await expect(validatePatches('/patches', '/engine')).resolves.toEqual({
      valid: false,
      errors: ['001-alpha.patch: Patch targets a path outside engine/: ../../etc/passwd'],
    });
    expect(exec).not.toHaveBeenCalled();
  });

  it('auto-resolves new-file conflicts during applyPatches', async () => {
    const patchContent = [
      'diff --git a/browser/new.js b/browser/new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/browser/new.js',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');

    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(filePath === '/patches' || filePath === '/engine/browser/new.js')
    );
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockImplementation((filePath) => {
      if (filePath === '/patches/001-alpha.patch' || filePath === '/patches/001-alpha.patch') {
        return Promise.resolve(patchContent);
      }
      if (filePath === '/engine/browser/new.js') {
        return Promise.resolve('existing file\n');
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/new.js']);
    vi.mocked(applyPatchIdempotent)
      .mockRejectedValueOnce(new Error('new file already exists'))
      .mockResolvedValueOnce(undefined);

    const results = await applyPatches('/patches', '/engine');

    expect(results).toEqual([
      {
        patch: { filename: '001-alpha.patch', path: '/patches/001-alpha.patch', order: 1 },
        success: true,
        autoResolved: true,
      },
    ]);
    expect(writeText).toHaveBeenCalledWith('/engine/browser/new.js', 'created\n');
    expect(applyPatchIdempotent).toHaveBeenCalledTimes(2);
  });

  it('restores original content and stops applyPatches after the first failed patch', async () => {
    const patchContent = [
      'diff --git a/browser/new.js b/browser/new.js',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/browser/new.js',
      '@@ -0,0 +1 @@',
      '+created',
      '',
    ].join('\n');

    vi.mocked(pathExists).mockImplementation((filePath) =>
      Promise.resolve(filePath === '/patches' || filePath === '/engine/browser/new.js')
    );
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockImplementation((filePath) => {
      if (filePath === '/patches/001-alpha.patch') {
        return Promise.resolve(patchContent);
      }
      if (filePath === '/engine/browser/new.js') {
        return Promise.resolve('existing file\n');
      }
      if (filePath === '/patches/002-beta.patch') {
        return Promise.resolve(
          'diff --git a/browser/unused.js b/browser/unused.js\n+++ b/browser/unused.js\n'
        );
      }
      throw new Error(`Unexpected file read: ${filePath}`);
    });
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/new.js']);
    vi.mocked(applyPatchIdempotent)
      .mockRejectedValueOnce(new Error('initial failure'))
      .mockRejectedValueOnce(new Error('retry failure'))
      .mockResolvedValueOnce(undefined);

    const results = await applyPatches('/patches', '/engine');

    expect(results).toEqual([
      {
        patch: { filename: '001-alpha.patch', path: '/patches/001-alpha.patch', order: 1 },
        success: false,
        error: 'initial failure',
      },
    ]);
    expect(writeText).toHaveBeenNthCalledWith(1, '/engine/browser/new.js', 'created\n');
    expect(writeText).toHaveBeenNthCalledWith(2, '/engine/browser/new.js', 'existing file\n');
    expect(applyPatchIdempotent).toHaveBeenNthCalledWith(3, '/patches/001-alpha.patch', '/engine', {
      reject: true,
    });
    expect(applyPatchIdempotent).toHaveBeenCalledTimes(3);
  });

  it('rejects patch paths that escape engine/ before applying writes', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/../../etc/passwd b/../../etc/passwd',
        '--- a/../../etc/passwd',
        '+++ b/../../etc/passwd',
      ].join('\n')
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['../../etc/passwd']);

    await expect(applyPatches('/patches', '/engine')).resolves.toEqual([
      {
        patch: { filename: '001-alpha.patch', path: '/patches/001-alpha.patch', order: 1 },
        success: false,
        error: 'Patch targets a path outside engine/: ../../etc/passwd',
      },
    ]);
    expect(applyPatchIdempotent).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
  });

  it('stops on the first failed patch when continue mode is disabled', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(extractConflictingFiles).mockReturnValue(['browser/modules/conflict.js']);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('context mismatch'))
      .mockRejectedValueOnce(new Error('reject pass failed'));

    const summary = await applyPatchesWithContinue('/patches', '/engine');

    expect(summary.total).toBe(3);
    expect(summary.succeeded).toHaveLength(1);
    expect(summary.succeeded[0]?.patch.filename).toBe('001-alpha.patch');
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({
      patch: { filename: '002-beta.patch' },
      success: false,
      error: 'reject pass failed',
      conflictingFiles: ['browser/modules/conflict.js'],
    });
    expect(summary.skipped).toEqual([
      { filename: '003-gamma.patch', path: '/patches/003-gamma.patch', order: 3 },
    ]);
    expect(applyPatchIdempotent).toHaveBeenCalledTimes(3);
  });

  it('continues applying later patches when continue mode is enabled', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(extractConflictingFiles).mockReturnValue(['browser/modules/conflict.js']);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('context mismatch'))
      .mockRejectedValueOnce(new Error('reject pass failed'))
      .mockResolvedValueOnce(undefined);

    const summary = await applyPatchesWithContinue('/patches', '/engine', true);

    expect(summary.total).toBe(3);
    expect(summary.succeeded.map((result) => result.patch.filename)).toEqual([
      '001-alpha.patch',
      '003-gamma.patch',
    ]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]?.patch.filename).toBe('002-beta.patch');
    expect(summary.skipped).toEqual([]);
    expect(applyPatchIdempotent).toHaveBeenCalledTimes(4);
  });

  it('returns HEAD content unchanged when no patches affect the file', async () => {
    vi.mocked(getFileContentFromHead).mockResolvedValue('base content\n');
    vi.mocked(findPatchesAffectingFile).mockResolvedValue([]);

    await expect(computePatchedContent('/patches', '/engine', 'browser/app.css')).resolves.toBe(
      'base content\n'
    );
    expect(applyPatchToContent).not.toHaveBeenCalled();
  });

  it('applies affecting patches in order when computing patched content', async () => {
    vi.mocked(getFileContentFromHead).mockResolvedValue('base content\n');
    vi.mocked(findPatchesAffectingFile).mockResolvedValue([
      {
        patch: { filename: '001-alpha.patch', path: '/patches/001-alpha.patch', order: 1 },
        metadata: {
          filename: '001-alpha.patch',
          order: 1,
          category: 'ui',
          name: 'alpha',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/app.css'],
        },
      },
      {
        patch: { filename: '002-beta.patch', path: '/patches/002-beta.patch', order: 2 },
        metadata: {
          filename: '002-beta.patch',
          order: 2,
          category: 'ui',
          name: 'beta',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/app.css'],
        },
      },
    ]);
    vi.mocked(applyPatchToContent)
      .mockResolvedValueOnce('after patch one\n')
      .mockResolvedValueOnce('after patch two\n');

    const result = await computePatchedContent('/patches', '/engine', 'browser/app.css');

    expect(applyPatchToContent).toHaveBeenNthCalledWith(
      1,
      'base content\n',
      '/patches/001-alpha.patch',
      'browser/app.css'
    );
    expect(applyPatchToContent).toHaveBeenNthCalledWith(
      2,
      'after patch one\n',
      '/patches/002-beta.patch',
      'browser/app.css'
    );
    expect(result).toBe('after patch two\n');
  });

  it('rolls back succeeded patches in applyPatches when a later patch fails', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined) // 001 succeeds
      .mockResolvedValueOnce(undefined) // 002 succeeds
      .mockRejectedValueOnce(new Error('context mismatch')) // 003 fails
      .mockRejectedValueOnce(new Error('reject also fails')); // 003 --reject pass

    const results = await applyPatches('/patches', '/engine');

    // 003 failed, 001 and 002 succeeded then got rolled back
    expect(results).toHaveLength(3);
    expect(results[0]?.success).toBe(true);
    expect(results[1]?.success).toBe(true);
    expect(results[2]?.success).toBe(false);

    // reversePatch called for both succeeded patches in reverse order
    expect(reversePatch).toHaveBeenCalledTimes(2);
    expect(reversePatch).toHaveBeenNthCalledWith(1, '/patches/002-beta.patch', '/engine');
    expect(reversePatch).toHaveBeenNthCalledWith(2, '/patches/001-alpha.patch', '/engine');
  });

  it('does not call reversePatch when the first patch fails in applyPatches', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent)
      .mockRejectedValueOnce(new Error('fails immediately'))
      .mockRejectedValueOnce(new Error('reject also fails'));

    await applyPatches('/patches', '/engine');

    expect(reversePatch).not.toHaveBeenCalled();
  });

  it('rolls back succeeded patches in applyPatchesWithContinue when continue is false', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(extractConflictingFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined) // 001 succeeds
      .mockRejectedValueOnce(new Error('context mismatch')) // 002 fails
      .mockRejectedValueOnce(new Error('reject also fails')); // 002 --reject pass

    const summary = await applyPatchesWithContinue('/patches', '/engine', false);

    expect(summary.succeeded).toHaveLength(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.skipped).toHaveLength(1);

    // 001-alpha rolled back
    expect(reversePatch).toHaveBeenCalledTimes(1);
    expect(reversePatch).toHaveBeenCalledWith('/patches/001-alpha.patch', '/engine');
  });

  it('does not roll back when continue mode is enabled', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(extractConflictingFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined) // 001 succeeds
      .mockRejectedValueOnce(new Error('fails')) // 002 fails
      .mockRejectedValueOnce(new Error('reject fails')); // 002 --reject pass

    await applyPatchesWithContinue('/patches', '/engine', true);

    // No rollback in continue mode
    expect(reversePatch).not.toHaveBeenCalled();
  });

  it('continues rolling back even if one reversePatch fails', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent)
      .mockResolvedValueOnce(undefined) // 001 succeeds
      .mockResolvedValueOnce(undefined) // 002 succeeds
      .mockRejectedValueOnce(new Error('003 fails')) // 003 fails
      .mockRejectedValueOnce(new Error('reject')); // 003 --reject pass

    // reversePatch fails for 002 but continues to 001
    vi.mocked(reversePatch)
      .mockRejectedValueOnce(new Error('reverse failed for 002'))
      .mockResolvedValueOnce(undefined);

    const results = await applyPatches('/patches', '/engine');

    expect(results[2]?.success).toBe(false);
    // Both reverse attempts were made even though one failed
    expect(reversePatch).toHaveBeenCalledTimes(2);
    expect(reversePatch).toHaveBeenNthCalledWith(1, '/patches/002-beta.patch', '/engine');
    expect(reversePatch).toHaveBeenNthCalledWith(2, '/patches/001-alpha.patch', '/engine');
  });
});
