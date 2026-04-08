// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn(() => Promise.resolve([])),
  commentStyleForFile: vi.fn((file: string) => {
    if (file.endsWith('.css')) return 'css';
    if (file.endsWith('.ftl')) return 'hash';
    if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.jsm')) return 'js';
    return null;
  }),
  detectNewFilesInDiff: vi.fn(() => new Set<string>()),
}));

vi.mock('../../core/patch-export.js', () => ({
  findAllPatchesForFiles: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/license-headers.js', () => ({
  getLicenseHeader: vi.fn(() => '// LICENSE HEADER'),
  addLicenseHeaderToFile: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  readText: vi.fn(() => Promise.resolve('const x = 1;\n')),
}));

vi.mock('../../utils/logger.js', () => ({
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  info: vi.fn(),
  warn: vi.fn(),
}));

import * as clack from '@clack/prompts';

import { addLicenseHeaderToFile } from '../../core/license-headers.js';
import { findAllPatchesForFiles } from '../../core/patch-export.js';
import { detectNewFilesInDiff, lintExportedPatch } from '../../core/patch-lint.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import type { SpinnerHandle } from '../../utils/logger.js';
import { cancel, info, isCancel, warn } from '../../utils/logger.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  promptExportPatchMetadata,
  runPatchLint,
} from '../export-shared.js';

const mockSpinner: SpinnerHandle = {
  message: vi.fn(),
  stop: vi.fn(),
  error: vi.fn(),
};

const mockConfig: FireForgeConfig = {
  name: 'TestBrowser',
  vendor: 'Test',
  appId: 'org.test.browser',
  binaryName: 'testbrowser',
  firefox: { version: '140.0esr', product: 'firefox-esr' },
  license: 'MPL-2.0',
};

describe('runPatchLint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when no issues found', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([]);
    await runPatchLint('/engine', ['a.js'], 'diff', mockConfig);

    expect(warn).not.toHaveBeenCalled();
  });

  it('displays warnings without blocking', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      {
        check: 'large-patch-files',
        file: '(patch)',
        message: 'too many files',
        severity: 'warning',
      },
    ]);
    await runPatchLint('/engine', ['a.js'], 'diff', mockConfig);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('too many files'));
  });

  it('blocks on errors when skipLint is false', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      { check: 'relative-import', file: 'a.mjs', message: 'bad import', severity: 'error' },
    ]);

    await expect(runPatchLint('/engine', ['a.mjs'], 'diff', mockConfig, false)).rejects.toThrow(
      GeneralError
    );
  });

  it('downgrades errors to warnings when skipLint is true', async () => {
    vi.mocked(lintExportedPatch).mockResolvedValueOnce([
      { check: 'relative-import', file: 'a.mjs', message: 'bad import', severity: 'error' },
    ]);

    await runPatchLint('/engine', ['a.mjs'], 'diff', mockConfig, true);

    expect(warn).toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('downgraded'));
  });
});

describe('promptExportPatchMetadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses CLI-provided name and category in non-interactive mode', async () => {
    const result = await promptExportPatchMetadata(
      { name: 'my-patch', category: 'ui', description: 'A patch' },
      false,
      'export'
    );

    expect(result).toEqual({
      patchName: 'my-patch',
      selectedCategory: 'ui',
      description: 'A patch',
    });
  });

  it('throws when name is missing in non-interactive mode', async () => {
    await expect(promptExportPatchMetadata({ category: 'ui' }, false, 'export')).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('throws when category is missing in non-interactive mode', async () => {
    await expect(promptExportPatchMetadata({ name: 'my-patch' }, false, 'export')).rejects.toThrow(
      InvalidArgumentError
    );
  });

  it('throws on invalid name from CLI', async () => {
    await expect(
      promptExportPatchMetadata({ name: 'INVALID NAME!', category: 'ui' }, false, 'export')
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('throws on invalid category from CLI', async () => {
    await expect(
      promptExportPatchMetadata({ name: 'my-patch', category: 'invalid' as 'ui' }, false, 'export')
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('returns null when name prompt is cancelled', async () => {
    vi.mocked(isCancel).mockReturnValueOnce(true);
    vi.mocked(clack.text).mockResolvedValueOnce(Symbol('cancel') as unknown as string);

    const result = await promptExportPatchMetadata({}, true, 'export');

    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledWith('Export cancelled');
  });

  it('returns null when category prompt is cancelled', async () => {
    vi.mocked(clack.text).mockResolvedValueOnce('my-patch');
    vi.mocked(isCancel)
      .mockReturnValueOnce(false) // name not cancelled
      .mockReturnValueOnce(true); // category cancelled
    vi.mocked(clack.select).mockResolvedValueOnce(Symbol('cancel') as unknown as string);

    const result = await promptExportPatchMetadata({}, true, 'export');

    expect(result).toBeNull();
  });

  it('prompts interactively for name, category, and description', async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce('my-change') // name
      .mockResolvedValueOnce('Some description'); // description
    vi.mocked(clack.select).mockResolvedValueOnce('privacy');

    const result = await promptExportPatchMetadata({}, true, 'export-all');

    expect(result).toEqual({
      patchName: 'my-change',
      selectedCategory: 'privacy',
      description: 'Some description',
    });
  });

  it('uses empty description when description prompt is cancelled', async () => {
    vi.mocked(clack.text)
      .mockResolvedValueOnce('my-change')
      .mockResolvedValueOnce(Symbol('cancel') as unknown as string);
    vi.mocked(clack.select).mockResolvedValueOnce('ui');
    vi.mocked(isCancel)
      .mockReturnValueOnce(false) // name
      .mockReturnValueOnce(false) // category
      .mockReturnValueOnce(true); // description cancelled

    const result = await promptExportPatchMetadata({}, true, 'export');

    expect(result?.description).toBe('');
  });
});

describe('confirmSupersedePatches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when no patches would be superseded', async () => {
    const result = await confirmSupersedePatches(
      '/patches',
      ['a.js'],
      undefined,
      false,
      mockSpinner
    );
    expect(result).toBe(true);
  });

  it('returns true when --supersede flag is set', async () => {
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      { path: '/patches/old.patch', filename: 'old.patch', order: 1 },
    ]);
    const result = await confirmSupersedePatches('/patches', ['a.js'], true, false, mockSpinner);
    expect(result).toBe(true);
  });

  it('throws in non-interactive mode without --supersede', async () => {
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      { path: '/patches/old.patch', filename: 'old.patch', order: 1 },
    ]);

    await expect(
      confirmSupersedePatches('/patches', ['a.js'], undefined, false, mockSpinner)
    ).rejects.toThrow(GeneralError);
  });

  it('returns false when user declines confirmation', async () => {
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      { path: '/patches/old.patch', filename: 'old.patch', order: 1 },
    ]);
    vi.mocked(isCancel).mockReturnValueOnce(true);
    vi.mocked(clack.confirm).mockResolvedValueOnce(Symbol('cancel') as unknown as boolean);

    const result = await confirmSupersedePatches(
      '/patches',
      ['a.js'],
      undefined,
      true,
      mockSpinner
    );
    expect(result).toBe(false);
    expect(cancel).toHaveBeenCalledWith('Export cancelled');
  });

  it('returns true when user confirms supersede', async () => {
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      { path: '/patches/old.patch', filename: 'old.patch', order: 1 },
    ]);
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);

    const result = await confirmSupersedePatches(
      '/patches',
      ['a.js'],
      undefined,
      true,
      mockSpinner
    );
    expect(result).toBe(true);
  });
});

describe('autoFixLicenseHeaders', () => {
  const newFileDiff =
    'diff --git a/new.js b/new.js\nnew file mode 100644\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1 @@\n+const x = 1;\n';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readText).mockResolvedValue('const x = 1;\n');
    vi.mocked(addLicenseHeaderToFile).mockResolvedValue(true);
  });

  it('returns false when no new files in diff', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set());

    const result = await autoFixLicenseHeaders('/engine', 'diff content', mockConfig, true);

    expect(result).toBe(false);
  });

  it('returns false in non-interactive mode', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['new.js']));

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, false);

    expect(result).toBe(false);
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
  });

  it('returns false when user declines prompt', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['new.js']));
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
  });

  it('adds headers and returns true when user confirms', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['new.js']));
    vi.mocked(clack.confirm).mockResolvedValueOnce(true);

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(true);
    expect(addLicenseHeaderToFile).toHaveBeenCalledWith('/engine/new.js', 'MPL-2.0', 'js');
  });

  it('skips files that already have the correct header', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['existing.js']));
    vi.mocked(readText).mockResolvedValue('// LICENSE HEADER\nconst x = 1;\n');

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
  });

  it('skips files with unsupported extensions', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['data.json']));

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
  });
});
