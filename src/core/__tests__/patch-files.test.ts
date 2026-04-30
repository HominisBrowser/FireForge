// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

import { readText } from '../../utils/fs.js';
import {
  getAllTargetFilesFromPatch,
  getTargetFileFromPatch,
  isNewFilePatch,
} from '../patch-files.js';

/**
 * Exercises `getAllTargetFilesFromPatch` with real patch content so we can
 * assert that the underlying parser (now `extractAffectedFiles`) captures
 * both text hunks and `GIT binary patch` sections.
 *
 * The orchestration test in `patch-apply-orchestration.test.ts` mocks
 * `extractAffectedFiles`, so this file is the canonical place for the
 * binary-path regression from the 0.16.0 eval run.
 */
describe('patch-files parsing', () => {
  it('returns text hunk targets in alphabetical order', async () => {
    vi.mocked(readText).mockResolvedValueOnce(
      [
        'diff --git a/browser/a.js b/browser/a.js',
        '--- a/browser/a.js',
        '+++ b/browser/a.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/browser/b.css b/browser/b.css',
        '--- a/browser/b.css',
        '+++ b/browser/b.css',
        '@@ -1 +1 @@',
        '-red',
        '+blue',
        '',
      ].join('\n')
    );

    await expect(getAllTargetFilesFromPatch('/patches/001.patch')).resolves.toEqual([
      'browser/a.js',
      'browser/b.css',
    ]);
  });

  it('captures binary file targets from GIT binary patch sections', async () => {
    // Regression: the earlier `+++ b/…` regex missed binary diffs (which
    // carry only the `diff --git a/… b/…` header, no `+++` line). Verify
    // mismatched against branding patches and the doctor repair rewrote
    // `filesAffected` to the text-only subset, hiding the true scope.
    vi.mocked(readText).mockResolvedValueOnce(
      [
        'diff --git a/browser/branding/mybrowser/content/about-logo.png b/browser/branding/mybrowser/content/about-logo.png',
        'new file mode 100644',
        'index 0000000..abc1234',
        'GIT binary patch',
        'literal 1024',
        'zcmeFzHere',
        '',
        'diff --git a/browser/branding/mybrowser/locales/en-US/brand.ftl b/browser/branding/mybrowser/locales/en-US/brand.ftl',
        '--- a/browser/branding/mybrowser/locales/en-US/brand.ftl',
        '+++ b/browser/branding/mybrowser/locales/en-US/brand.ftl',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')
    );

    await expect(getAllTargetFilesFromPatch('/patches/002.patch')).resolves.toEqual([
      'browser/branding/mybrowser/content/about-logo.png',
      'browser/branding/mybrowser/locales/en-US/brand.ftl',
    ]);
  });

  it('returns the first `+++ b/…` target via getTargetFileFromPatch', async () => {
    vi.mocked(readText).mockResolvedValueOnce(
      [
        'diff --git a/foo.js b/foo.js',
        '--- a/foo.js',
        '+++ b/foo.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')
    );

    await expect(getTargetFileFromPatch('/patches/001.patch')).resolves.toBe('foo.js');
  });

  it('flags new-file patches via isNewFilePatch', async () => {
    vi.mocked(readText).mockResolvedValueOnce(
      [
        'diff --git a/foo.js b/foo.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/foo.js',
        '@@ -0,0 +1 @@',
        '+first',
        '',
      ].join('\n')
    );

    await expect(isNewFilePatch('/patches/001.patch')).resolves.toBe(true);
  });
});
