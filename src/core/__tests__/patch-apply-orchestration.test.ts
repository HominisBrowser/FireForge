// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/process.js', () => ({
  exec: vi.fn(),
}));

vi.mock('../git.js', () => ({
  applyPatchIdempotent: vi.fn(),
  reversePatch: vi.fn(),
}));

vi.mock('../git-file-ops.js', () => ({
  getFileContentAtRef: vi.fn(),
}));

vi.mock('../patch-manifest.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../patch-manifest.js')>();
  return {
    ...actual,
    loadPatchesManifest: vi.fn(),
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
    applyPatchTextToContent: vi.fn(),
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

import { nativePath } from '../../test-utils/index.js';
import { pathExists, readText } from '../../utils/fs.js';
import { applyPatchIdempotent, reversePatch } from '../git.js';
import { getFileContentAtRef } from '../git-file-ops.js';
import {
  applyPatchesWithContinue,
  countPatches,
  createPatchedContentContext,
  discoverPatches,
} from '../patch-apply.js';
import { getAllTargetFilesFromPatch } from '../patch-files.js';
import { loadPatchesManifest } from '../patch-manifest.js';
import { extractAffectedFiles, extractConflictingFiles } from '../patch-parse.js';
import { applyPatchTextToContent } from '../patch-transform.js';

describe('patch orchestration helpers', () => {
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
      { path: nativePath('/patches/001-alpha.patch'), filename: '001-alpha.patch', order: 1 },
      { path: nativePath('/patches/001-bravo.patch'), filename: '001-bravo.patch', order: 1 },
      { path: nativePath('/patches/010-zebra.patch'), filename: '010-zebra.patch', order: 10 },
    ]);
    await expect(countPatches('/patches')).resolves.toBe(3);
  });

  it('parses target file helpers from patch content', async () => {
    // `getAllTargetFilesFromPatch` delegates to `extractAffectedFiles` (mocked
    // in this file). The real parser is exercised by the unit test in
    // `patch-files.test.ts`; here we confirm the orchestration layer calls
    // through correctly.
    vi.mocked(extractAffectedFiles).mockReturnValueOnce(['foo.js', 'bar.css']);

    await expect(getAllTargetFilesFromPatch('/patches/001-foo.patch')).resolves.toEqual([
      'foo.js',
      'bar.css',
    ]);
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
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
      { filename: '003-gamma.patch', path: nativePath('/patches/003-gamma.patch'), order: 3 },
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

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      continueOnFailure: true,
    });

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
    vi.mocked(getFileContentAtRef).mockResolvedValue('base content\n');
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    vi.mocked(pathExists).mockResolvedValue(false);

    const ctx = await createPatchedContentContext('/patches', '/engine');
    await expect(ctx.computePatched('browser/app.css')).resolves.toBe('base content\n');
    expect(applyPatchTextToContent).not.toHaveBeenCalled();
  });

  it('applies affecting patches in order and reads each body once when computing patched content', async () => {
    vi.mocked(getFileContentAtRef).mockResolvedValue('base content\n');
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-alpha.patch',
          order: 1,
          category: 'ui',
          name: 'alpha',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/app.css'],
        },
        {
          filename: '002-beta.patch',
          order: 2,
          category: 'ui',
          name: 'beta',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/app.css'],
        },
      ],
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as never);
    vi.mocked(readText).mockImplementation((filePath) =>
      Promise.resolve(filePath === nativePath('/patches/001-alpha.patch') ? 'body-one' : 'body-two')
    );
    vi.mocked(applyPatchTextToContent)
      .mockReturnValueOnce('after patch one\n')
      .mockReturnValueOnce('after patch two\n');

    const ctx = await createPatchedContentContext('/patches', '/engine');
    const result = await ctx.computePatched('browser/app.css');

    expect(applyPatchTextToContent).toHaveBeenNthCalledWith(
      1,
      'base content\n',
      'body-one',
      'browser/app.css'
    );
    expect(applyPatchTextToContent).toHaveBeenNthCalledWith(
      2,
      'after patch one\n',
      'body-two',
      'browser/app.css'
    );
    expect(result).toBe('after patch two\n');

    // Bodies are memoized: a second computation re-applies but re-reads nothing.
    const readsAfterFirst = vi.mocked(readText).mock.calls.length;
    await ctx.computePatched('browser/app.css');
    expect(vi.mocked(readText).mock.calls.length).toBe(readsAfterFirst);
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

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      continueOnFailure: false,
    });

    expect(summary.succeeded).toHaveLength(1);
    expect(summary.failed).toHaveLength(1);
    expect(summary.skipped).toHaveLength(1);

    // 001-alpha rolled back
    expect(reversePatch).toHaveBeenCalledTimes(1);
    expect(reversePatch).toHaveBeenCalledWith(nativePath('/patches/001-alpha.patch'), '/engine');
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

    await applyPatchesWithContinue('/patches', '/engine', { continueOnFailure: true });

    // No rollback in continue mode
    expect(reversePatch).not.toHaveBeenCalled();
  });

  it('stops applying after the --until patch when untilFilename is a bare ordinal', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
      { name: '003-gamma.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent).mockResolvedValue(undefined);

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      untilFilename: '2',
    });

    expect(summary.succeeded.map((r) => r.patch.filename)).toEqual([
      '001-alpha.patch',
      '002-beta.patch',
    ]);
    expect(summary.skipped.map((p) => p.filename)).toEqual(['003-gamma.patch']);
    expect(summary.failed).toEqual([]);
    // The numeric form normalizes leading zeros, so '2' and '002' pick the
    // same patch.
    expect(applyPatchIdempotent).toHaveBeenCalledTimes(2);
  });

  it('stops applying after the --until patch when untilFilename is a padded ordinal', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent).mockResolvedValue(undefined);

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      untilFilename: '001',
    });

    expect(summary.succeeded.map((r) => r.patch.filename)).toEqual(['001-alpha.patch']);
    expect(summary.skipped.map((p) => p.filename)).toEqual(['002-beta.patch']);
  });

  it('stops applying after the --until patch when untilFilename is an exact filename', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent).mockResolvedValue(undefined);

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      untilFilename: '001-alpha.patch',
    });

    expect(summary.succeeded.map((r) => r.patch.filename)).toEqual(['001-alpha.patch']);
    expect(summary.skipped.map((p) => p.filename)).toEqual(['002-beta.patch']);
  });

  it('stops applying after the --until patch when untilFilename omits the .patch suffix', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '002-beta.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);
    vi.mocked(readText).mockResolvedValue('diff --git a/a.js b/a.js\n+++ b/a.js\n');
    vi.mocked(extractAffectedFiles).mockReturnValue([]);
    vi.mocked(applyPatchIdempotent).mockResolvedValue(undefined);

    const summary = await applyPatchesWithContinue('/patches', '/engine', {
      untilFilename: '001-alpha',
    });

    expect(summary.succeeded.map((r) => r.patch.filename)).toEqual(['001-alpha.patch']);
  });

  it('throws with an ambiguity error when --until matches multiple patches by ordinal', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    // Two files share ordinal "001" — a corrupted queue, but --until
    // should surface it instead of silently picking the first.
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
      { name: '001-bravo.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await expect(
      applyPatchesWithContinue('/patches', '/engine', { untilFilename: '1' })
    ).rejects.toThrow(/ambiguous/);
  });

  it('throws when --until identifier does not match any patch', async () => {
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([
      { name: '001-alpha.patch', isFile: () => true },
    ] as unknown as Awaited<ReturnType<typeof readdir>>);

    await expect(
      applyPatchesWithContinue('/patches', '/engine', { untilFilename: '999' })
    ).rejects.toThrow(/does not match any patch/);
  });
});
