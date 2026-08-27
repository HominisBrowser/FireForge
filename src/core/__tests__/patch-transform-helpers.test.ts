// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/fs.js', () => createFsMock());

import { PatchError } from '../../errors/patch.js';
import { readText } from '../../utils/fs.js';
import { applyPatchToContent, extractNewFileContent } from '../patch-transform.js';

const NEW_FILE_MULTI_PATCH = [
  'diff --git a/browser/new-file.js b/browser/new-file.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/browser/new-file.js',
  '@@ -0,0 +1,2 @@',
  '+export const created = true;',
  '+console.log(created);',
  'diff --git a/browser/other-file.js b/browser/other-file.js',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/browser/other-file.js',
  '@@ -0,0 +1 @@',
  '+export const other = true;',
  '',
].join('\n');

describe('patch transform helper coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('extracts only the requested file content from a multi-file new-file patch', async () => {
    vi.mocked(readText).mockResolvedValue(NEW_FILE_MULTI_PATCH);

    await expect(
      extractNewFileContent('/patches/001-new-file.patch', 'browser/new-file.js')
    ).resolves.toBe('export const created = true;\nconsole.log(created);\n');
  });

  it('extracts new file content without a trailing newline when the patch declares none', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/no-newline.js b/browser/no-newline.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/browser/no-newline.js',
        '@@ -0,0 +1 @@',
        '+export const bare = true;',
        '\\ No newline at end of file',
        '',
      ].join('\n')
    );

    await expect(
      extractNewFileContent('/patches/001-no-newline.patch', 'browser/no-newline.js')
    ).resolves.toBe('export const bare = true;');
  });

  it('extracts new file content when applyPatchToContent is given null content for a new file patch', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/created.js b/browser/created.js',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/browser/created.js',
        '@@ -0,0 +1,2 @@',
        '+export const created = true;',
        '+created();',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent(null, '/patches/001-created.patch', 'browser/created.js')
    ).resolves.toBe('export const created = true;\ncreated();\n');
  });

  it('returns empty content when applying a non-new-file patch to a missing file', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/existing.js b/browser/existing.js',
        '--- a/browser/existing.js',
        '+++ b/browser/existing.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent(null, '/patches/001-existing.patch', 'browser/existing.js')
    ).resolves.toBe('');
  });

  it('returns the original content unchanged when the patch does not affect the target file', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/other.js b/browser/other.js',
        '--- a/browser/other.js',
        '+++ b/browser/other.js',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent('base content\n', '/patches/001-other.patch', 'browser/unaffected.js')
    ).resolves.toBe('base content\n');
  });

  it('applies multi-hunk patches in reverse order and respects a final no-newline marker', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/app.js b/browser/app.js',
        '--- a/browser/app.js',
        '+++ b/browser/app.js',
        '@@ -1,2 +1,2 @@',
        '-line1',
        '+line1-updated',
        ' line2',
        '@@ -4,2 +4,3 @@',
        ' line4',
        '-line5',
        '+line5a',
        '+line5b',
        '\\ No newline at end of file',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent(
        'line1\nline2\nline3\nline4\nline5\n',
        '/patches/001-app.patch',
        'browser/app.js'
      )
    ).resolves.toBe('line1-updated\nline2\nline3\nline4\nline5a\nline5b');
  });

  it('throws a PatchError when the hunk header count does not match the body', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/app.js b/browser/app.js',
        '--- a/browser/app.js',
        '+++ b/browser/app.js',
        '@@ -1,3 +1,2 @@',
        ' line1',
        '-line2',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent('line1\nline2\nline3\n', '/patches/001-app.patch', 'browser/app.js')
    ).rejects.toThrow(PatchError);
  });

  it('throws a PatchError when the patch context does not match the target content', async () => {
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/app.js b/browser/app.js',
        '--- a/browser/app.js',
        '+++ b/browser/app.js',
        '@@ -1,2 +1,2 @@',
        ' expected-one',
        '-expected-two',
        '+replacement-two',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent('actual-one\nexpected-two\n', '/patches/001-app.patch', 'browser/app.js')
    ).rejects.toThrow(PatchError);
  });

  it('emits a trailing newline when only the old side lacks one (asymmetric)', async () => {
    // The marker follows `-line2`, so it annotates only the old-side.
    // The new-side ends with `line2-modified` plus an implicit trailing
    // newline; the projected content must match what `git apply` would
    // write so `fireforge status` does not drift into a phantom diff.
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/asym.js b/browser/asym.js',
        '--- a/browser/asym.js',
        '+++ b/browser/asym.js',
        '@@ -1,2 +1,2 @@',
        ' line1',
        '-line2',
        '\\ No newline at end of file',
        '+line2-modified',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent('line1\nline2', '/patches/001-asym.patch', 'browser/asym.js')
    ).resolves.toBe('line1\nline2-modified\n');
  });

  it('omits the trailing newline when only the new side lacks one (asymmetric)', async () => {
    // Mirror of the previous case: the marker trails `+line2-modified`,
    // so the new side lacks a trailing newline even though the old one
    // had it.
    vi.mocked(readText).mockResolvedValue(
      [
        'diff --git a/browser/asym.js b/browser/asym.js',
        '--- a/browser/asym.js',
        '+++ b/browser/asym.js',
        '@@ -1,2 +1,2 @@',
        ' line1',
        '-line2',
        '+line2-modified',
        '\\ No newline at end of file',
        '',
      ].join('\n')
    );

    await expect(
      applyPatchToContent('line1\nline2\n', '/patches/001-asym.patch', 'browser/asym.js')
    ).resolves.toBe('line1\nline2-modified');
  });
});
