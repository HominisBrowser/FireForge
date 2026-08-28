// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock('../../core/patch-lint.js', () => ({
  formatPatchLintIssue: vi.fn(
    (issue: { check: string; file: string; message: string }) =>
      `[${issue.check}] ${issue.file}: ${issue.message}`
  ),
  lintExportedPatch: vi.fn(() => Promise.resolve([])),
  commentStyleForFile: vi.fn((file: string) => {
    if (file.endsWith('.css')) return 'css';
    if (file.endsWith('.ftl')) return 'hash';
    if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.jsm')) return 'js';
    return null;
  }),
  detectNewFilesInDiff: vi.fn(() => new Set<string>()),
  // Mimics the real predicate's project-header branch against the mocked
  // getLicenseHeader below; the full acceptance policy (upstream MPL
  // block form, branding carve-out) is covered by patch-lint.test.ts.
  isAcceptableNewFileHeader: vi.fn((_file: string, content: string) =>
    content.startsWith('// LICENSE HEADER')
  ),
  resolvePatchSizeTier: vi.fn(() => ({ tier: 'general' })),
}));

vi.mock('../../core/patch-export.js', () => ({
  findAllPatchesForFiles: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../core/license-headers.js', async (importOriginal) => ({
  // Keep the real (pure) hasThirdPartyPermissiveBanner so the vendored
  // partition behaves authentically; stub the header writer/reader.
  ...(await importOriginal<typeof import('../../core/license-headers.js')>()),
  getLicenseHeader: vi.fn(() => '// LICENSE HEADER'),
  addLicenseHeaderToFile: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
  readText: vi.fn(() => Promise.resolve('const x = 1;\n')),
}));

vi.mock('../../utils/logger.js', () => createLoggerMock());

import * as clack from '@clack/prompts';

import { addLicenseHeaderToFile } from '../../core/license-headers.js';
import { findAllPatchesForFiles } from '../../core/patch-export.js';
import {
  detectNewFilesInDiff,
  isAcceptableNewFileHeader,
  lintExportedPatch,
} from '../../core/patch-lint.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import { nativePath } from '../../test-utils/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { pathExists, readText } from '../../utils/fs.js';
import type { SpinnerHandle } from '../../utils/logger.js';
import { cancel, info, isCancel, warn } from '../../utils/logger.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  findPartialOwnershipOverlap,
  guardOwnershipOverlap,
  promptExportPatchMetadata,
  runPatchLint,
  runSupersedeAndOverlapGates,
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
  firefox: { version: '140.9.0esr', product: 'firefox-esr' },
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

  it('normalizes a category-prefixed name to the bare slug in one step', async () => {
    await expect(
      promptExportPatchMetadata({ name: 'ui-foo', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: 'foo' });
    await expect(
      promptExportPatchMetadata({ name: '203-ui-foo', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: 'foo' });
    await expect(
      promptExportPatchMetadata({ name: 'UI-Foo', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: 'Foo' });
  });

  it('accepts a filename-shaped --name by stripping the.patch extension', async () => {
    await expect(
      promptExportPatchMetadata({ name: 'ui-foo.patch', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: 'foo' });
  });

  it('never strips a bare leading number or a non-category prefix', async () => {
    await expect(
      promptExportPatchMetadata({ name: '2-step-verification', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: '2-step-verification' });
    await expect(
      promptExportPatchMetadata({ name: 'core-foo', category: 'ui' }, false, 'export')
    ).resolves.toMatchObject({ patchName: 'core-foo' });
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
      promptExportPatchMetadata({ name: 'my-patch', category: 'invalid' }, false, 'export')
    ).rejects.toThrow(InvalidArgumentError);
  });

  it('returns null when name prompt is cancelled', async () => {
    vi.mocked(isCancel).mockReturnValueOnce(true);
    vi.mocked(clack.text).mockResolvedValueOnce(Symbol('cancel'));

    const result = await promptExportPatchMetadata({}, true, 'export');

    expect(result).toBeNull();
    expect(cancel).toHaveBeenCalledWith('Export cancelled');
  });

  it('returns null when category prompt is cancelled', async () => {
    vi.mocked(clack.text).mockResolvedValueOnce('my-patch');
    vi.mocked(isCancel)
      .mockReturnValueOnce(false) // name not cancelled
      .mockReturnValueOnce(true); // category cancelled
    vi.mocked(clack.select).mockResolvedValueOnce(Symbol('cancel'));

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
      .mockResolvedValueOnce(Symbol('cancel'));
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
    vi.mocked(clack.confirm).mockResolvedValueOnce(Symbol('cancel'));

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
    expect(addLicenseHeaderToFile).toHaveBeenCalledWith(
      nativePath('/engine/new.js'),
      'MPL-2.0',
      'js'
    );
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

  it('never offers to stack a header onto a file the lint already accepts', async () => {
    // The fixer and the missing-license-header rule share
    // isAcceptableNewFileHeader: a file the rule accepts (e.g. a derived
    // JS/CSS file carrying the verbatim upstream MPL block header on a
    // non-MPL project) must not be offered a second, stacked header.
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['upstream-derived.css']));
    vi.mocked(isAcceptableNewFileHeader).mockReturnValueOnce(true);

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
  });

  it('never offers a project header on a vendored MIT-bannered file', async () => {
    const mitBundle =
      '/**\n' +
      ' * Copyright (c) 2019 The xterm.js authors. All rights reserved.\n' +
      ' * @license MIT License\n' +
      ' *\n' +
      ' * Permission is hereby granted, free of charge, to any person obtaining a copy\n' +
      ' */\n' +
      'export const term = 1;\n';
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['vendored/xterm.js']));
    vi.mocked(readText).mockResolvedValue(mitBundle);

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('third-party permissive license banner')
    );
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('--lint-ignore missing-license-header')
    );
  });

  it('never offers a project header on a CC0 public-domain upstream test file', async () => {
    // Firefox test files carry a CC0 dedication, not the MPL header. Before
    // CC0 was recognized this file was neither "acceptable" nor "vendored",
    // so `export -y` prepended the PROJECT's license header onto code
    // Mozilla dedicated to the public domain — the mislicensing the
    // vendored carve-out exists to prevent.
    const cc0Test =
      '/* Any copyright is dedicated to the Public Domain.\n' +
      '   http://creativecommons.org/publicdomain/zero/1.0/ */\n' +
      '"use strict";\n' +
      'add_task(async function () {});\n';
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(
      new Set(['browser/base/content/test/foo/browser_copied.js'])
    );
    vi.mocked(readText).mockResolvedValue(cc0Test);

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true);

    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('third-party permissive license banner')
    );
  });

  it('reports vendored files separately from fixable ones under dry-run', async () => {
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['vendored/d3.js', 'new.js']));
    vi.mocked(readText).mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('d3')
          ? '// SPDX-License-Identifier: ISC\nexport const d3 = 1;\n'
          : 'const x = 1;\n'
      )
    );

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true, true);

    expect(result).toBe(false);
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
    expect(vi.mocked(info)).toHaveBeenCalledWith(
      expect.stringContaining('third-party permissive license banner')
    );
    // The genuinely fixable file still gets the dry-run report — vendored
    // files must not appear in that list.
    const dryRunLine = vi
      .mocked(info)
      .mock.calls.map((c) => c[0])
      .find((m) => m.includes('[dry-run]'));
    expect(dryRunLine).toContain('new.js');
    expect(dryRunLine).not.toContain('d3.js');
  });

  it('never prompts or writes under dry-run — reports the missing headers instead', async () => {
    // Dry-run purity: an interactive `export --dry-run` must not prompt
    // (default Yes) and write license headers into engine/, then close with
    // "no changes made".
    vi.mocked(detectNewFilesInDiff).mockReturnValueOnce(new Set(['new.js']));

    const result = await autoFixLicenseHeaders('/engine', newFileDiff, mockConfig, true, true);

    expect(result).toBe(false);
    expect(clack.confirm).not.toHaveBeenCalled();
    expect(addLicenseHeaderToFile).not.toHaveBeenCalled();
    expect(vi.mocked(info)).toHaveBeenCalledWith(expect.stringContaining('[dry-run]'));
  });
});

describe('findPartialOwnershipOverlap', () => {
  // Two exports can both claim `browser/themes/shared/jar.inc.mn`.
  // `findAllPatchesForFiles` only catches FULL supersedes; partial overlap
  // needs its own detector.
  it('returns an empty map when nothing overlaps', () => {
    const manifest = {
      version: 1 as const,
      patches: [
        {
          filename: '001.patch',
          order: 1,
          category: 'ui' as const,
          name: 'one',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['foo.js'],
        },
      ],
    };
    expect(findPartialOwnershipOverlap(manifest, ['bar.js'], new Set())).toEqual(new Map());
  });

  it('surfaces files claimed by other non-superseded patches', () => {
    const manifest = {
      version: 1 as const,
      patches: [
        {
          filename: '001.patch',
          order: 1,
          category: 'ui' as const,
          name: 'one',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['shared.mn'],
        },
        {
          filename: '002.patch',
          order: 2,
          category: 'ui' as const,
          name: 'two',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['shared.mn', 'only-in-two.css'],
        },
      ],
    };
    const overlap = findPartialOwnershipOverlap(manifest, ['shared.mn'], new Set());
    expect(overlap.get('shared.mn')).toEqual(['001.patch', '002.patch']);
  });

  it('excludes supersede-targeted patches from the overlap result', () => {
    const manifest = {
      version: 1 as const,
      patches: [
        {
          filename: '001.patch',
          order: 1,
          category: 'ui' as const,
          name: 'one',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['shared.mn'],
        },
      ],
    };
    const overlap = findPartialOwnershipOverlap(manifest, ['shared.mn'], new Set(['001.patch']));
    expect(overlap.size).toBe(0);
  });
});

describe('guardOwnershipOverlap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through when --allow-overlap is set', async () => {
    const result = await guardOwnershipOverlap({
      patchesDir: '/patches',
      filesAffected: ['shared.mn'],
      supersedingFilenames: new Set(),
      allowOverlap: true,
      isInteractive: false,
      s: mockSpinner,
    });
    expect(result).toBe(true);
    expect(loadPatchesManifest).not.toHaveBeenCalled();
  });

  it('throws in non-interactive mode when overlap exists', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001.patch',
          order: 1,
          category: 'ui',
          name: 'one',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['shared.mn'],
        },
      ],
    });
    await expect(
      guardOwnershipOverlap({
        patchesDir: '/patches',
        filesAffected: ['shared.mn'],
        supersedingFilenames: new Set(),
        allowOverlap: false,
        isInteractive: false,
        s: mockSpinner,
      })
    ).rejects.toThrow(/cross-patch ownership overlap in non-interactive mode/);
  });

  it('proceeds silently when the manifest is empty (no overlap possible)', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce(null);
    const result = await guardOwnershipOverlap({
      patchesDir: '/patches',
      filesAffected: ['shared.mn'],
      supersedingFilenames: new Set(),
      allowOverlap: false,
      isInteractive: false,
      s: mockSpinner,
    });
    expect(result).toBe(true);
  });

  it('prompts and respects cancellation in interactive mode', async () => {
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001.patch',
          order: 1,
          category: 'ui',
          name: 'one',
          description: '',
          createdAt: '',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['shared.mn'],
        },
      ],
    });
    vi.mocked(clack.confirm).mockResolvedValueOnce(false);

    const result = await guardOwnershipOverlap({
      patchesDir: '/patches',
      filesAffected: ['shared.mn'],
      supersedingFilenames: new Set(),
      allowOverlap: false,
      isInteractive: true,
      s: mockSpinner,
    });
    expect(result).toBe(false);
    expect(cancel).toHaveBeenCalledWith('Export cancelled');
  });
});

describe('runSupersedeAndOverlapGates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when neither gate has anything to flag', async () => {
    const result = await runSupersedeAndOverlapGates({
      patchesDir: '/patches',
      filesAffected: ['a.js'],
      supersede: undefined,
      allowOverlap: false,
      isInteractive: false,
      s: mockSpinner,
    });
    expect(result).toBe(true);
  });

  it('returns false when the operator declines the supersede gate', async () => {
    vi.mocked(findAllPatchesForFiles).mockResolvedValue([
      { path: '/patches/old.patch', filename: 'old.patch', order: 1 },
    ]);
    vi.mocked(isCancel).mockReturnValueOnce(true);
    vi.mocked(clack.confirm).mockResolvedValueOnce(Symbol('cancel'));

    const result = await runSupersedeAndOverlapGates({
      patchesDir: '/patches',
      filesAffected: ['a.js'],
      supersede: undefined,
      allowOverlap: false,
      isInteractive: true,
      s: mockSpinner,
    });
    expect(result).toBe(false);
    expect(vi.mocked(loadPatchesManifest)).not.toHaveBeenCalled();
  });
});
