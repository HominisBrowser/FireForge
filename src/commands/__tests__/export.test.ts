// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { nativePath } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn().mockReturnValue({
    root: '/fake/root',
    engine: nativePath('/fake/engine'),
    patches: nativePath('/fake/patches'),
    config: nativePath('/fake/root/fireforge.json'),
    fireforgeDir: nativePath('/fake/root/.fireforge'),
    state: nativePath('/fake/root/.fireforge/state.json'),
    configs: nativePath('/fake/root/configs'),
    src: nativePath('/fake/root/src'),
    componentsDir: nativePath('/fake/root/src/components'),
  }),
  loadConfig: vi.fn().mockResolvedValue({
    firefox: { version: '140.9.0esr' },
  }),
}));

vi.mock('../../core/git.js', () => ({
  // Engine-precondition ladder (assertEngineGitReady). Stubbed to the
  // healthy-engine answers so these suites test their own subject.
  getHead: vi.fn(() => Promise.resolve('0'.repeat(40))),
  isMissingHeadError: vi.fn(() => false),

  isGitRepository: vi.fn().mockResolvedValue(true),
  getStatusWithCodes: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/git-diff.js', () => ({
  generateFullFilePatch: vi.fn(),
  generateBinaryFilePatch: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../core/git-file-ops.js', () => ({
  isBinaryFile: vi.fn().mockResolvedValue(false),
}));

vi.mock('../../core/git-status.js', () => ({
  resolveMaxUntrackedFilesPerDir: vi.fn(() => 5000),
  getUntrackedFiles: vi.fn().mockResolvedValue([]),
  getModifiedFilesInDir: vi.fn().mockResolvedValue([]),
  getUntrackedFilesInDir: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  // Default: no patches.json yet, so ownership auto-exclusion is a no-op.
  loadPatchesManifest: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../core/patch-apply.js', () => ({
  extractAffectedFiles: vi.fn().mockReturnValue([]),
}));

vi.mock('../../core/patch-export.js', () => ({
  commitExportedPatch: vi.fn().mockResolvedValue({
    patchFilename: '001-ui-test.patch',
    metadata: {
      filename: '001-ui-test.patch',
      order: 1,
      category: 'ui',
      name: 'test',
      description: '',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceEsrVersion: '140.9.0esr',
      filesAffected: [],
    },
    superseded: [],
  }),
  findAllPatchesForFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-lint.js', () => ({
  formatPatchLintIssue: vi.fn(
    (issue: { check: string; file: string; message: string }) =>
      `[${issue.check}] ${issue.file}: ${issue.message}`
  ),
  lintExportedPatch: vi.fn().mockResolvedValue([]),
  detectNewFilesInDiff: vi.fn().mockReturnValue(new Set()),
  commentStyleForFile: vi.fn().mockReturnValue(null),
  buildPatchQueueContext: vi.fn().mockResolvedValue({ entries: [] }),
  resolvePatchSizeTier: vi.fn().mockReturnValue({ tier: 'general' }),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

// The stale-furnace gate's detection logic is covered by
// src/core/__tests__/furnace-stale-export.test.ts. Here it is mocked to a
// no-op so existing tests are unaffected, with dedicated wiring tests
// asserting the call and the refusal propagation.
vi.mock('../../core/furnace-stale-export.js', () => ({
  enforceFreshFurnaceSources: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn().mockReturnValue({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  }),
  isCancel: vi.fn().mockReturnValue(false),
  cancel: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  select: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    stat: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  };
});

import { stat } from 'node:fs/promises';

import { enforceFreshFurnaceSources } from '../../core/furnace-stale-export.js';
import { getStatusWithCodes, isGitRepository } from '../../core/git.js';
import { generateBinaryFilePatch, generateFullFilePatch } from '../../core/git-diff.js';
import { isBinaryFile } from '../../core/git-file-ops.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../../core/git-status.js';
import { extractAffectedFiles } from '../../core/patch-apply.js';
import { commitExportedPatch, findAllPatchesForFiles } from '../../core/patch-export.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { exportCommand, registerExport } from '../export.js';

/** Helper to create a stat mock that returns directory or file based on path */
function mockStatForPaths(dirPaths: string[]): void {
  vi.mocked(stat).mockImplementation((p) => {
    const pathStr = String(p);
    const isDir = dirPaths.some((d) => pathStr.endsWith(nativePath(d)));
    return Promise.resolve({ isDirectory: () => isDir } as Awaited<ReturnType<typeof stat>>);
  });
}

function createProgram(): Command {
  const program = new Command();

  registerExport(program, {
    getProjectRoot: () => '/fake/root',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

beforeEach(() => {
  vi.mocked(pathExists).mockResolvedValue(true);
  vi.mocked(isGitRepository).mockResolvedValue(true);
});

describe('exportCommand - guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatForPaths([]);
  });

  it('fails early when the engine checkout is missing', async () => {
    const { pathExists } = await import('../../utils/fs.js');
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(targetPath !== nativePath('/fake/engine'))
    );

    await expect(
      exportCommand('/fake/root', ['browser/base/content/browser.js'], {
        name: 'missing-engine',
        category: 'ui',
      })
    ).rejects.toThrow('Firefox source not found. Run "fireforge download" first.');
  });

  it('fails early when the engine directory is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);

    await expect(
      exportCommand('/fake/root', ['browser/base/content/browser.js'], {
        name: 'not-git',
        category: 'ui',
      })
    ).rejects.toThrow(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  });
});

describe('exportCommand - directory support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export a directory with multiple text files', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['dir/b.js']);
    vi.mocked(generateFullFilePatch)
      .mockResolvedValueOnce('diff --git a/dir/a.js b/dir/a.js\n+content a\n')
      .mockResolvedValueOnce('diff --git a/dir/b.js b/dir/b.js\n+content b\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js', 'dir/b.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    expect(generateFullFilePatch).toHaveBeenCalledTimes(2);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/b.js');
  });

  // Stale-furnace gate wiring.

  it('runs the stale-furnace gate over the export files before diffing', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(generateFullFilePatch).mockResolvedValue('diff --git a/dir/a.js b/dir/a.js\n+a\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    expect(enforceFreshFurnaceSources).toHaveBeenCalledWith(
      '/fake/root',
      ['dir/a.js'],
      false,
      'export'
    );
  });

  it('forwards --allow-stale-furnace into the gate and refusals propagate', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(generateFullFilePatch).mockResolvedValue('diff --git a/dir/a.js b/dir/a.js\n+a\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
      allowStaleFurnace: true,
    });
    expect(enforceFreshFurnaceSources).toHaveBeenCalledWith(
      '/fake/root',
      ['dir/a.js'],
      true,
      'export'
    );

    vi.mocked(enforceFreshFurnaceSources).mockRejectedValueOnce(
      new Error('Component source for moz-tiles has changed since the last furnace apply')
    );
    await expect(
      exportCommand('/fake/root', ['dir'], {
        name: 'test-dir',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow(/moz-tiles/);
  });

  it('auto-excludes directory-derived files owned by other patches', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js', 'dir/b.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '002-ui-earlier.patch',
          order: 2,
          category: 'ui',
          name: 'earlier',
          description: 'earlier patch owning dir/a.js',
          createdAt: '2025-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['dir/a.js'],
        },
      ],
    });
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/dir/b.js b/dir/b.js\n+content b\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/b.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    // Only the unowned file is diffed. The owned one is excluded with a notice.
    expect(generateFullFilePatch).toHaveBeenCalledTimes(1);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/b.js');
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Excluding dir/a.js from the directory export (owned by 002-ui-earlier.patch)'
      )
    );
  });

  it('errors clearly when every directory file is owned by other patches', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(loadPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '002-ui-earlier.patch',
          order: 2,
          category: 'ui',
          name: 'earlier',
          description: 'earlier',
          createdAt: '2025-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['dir/a.js'],
        },
      ],
    });

    await expect(
      exportCommand('/fake/root', ['dir'], { name: 'x', category: 'ui', description: 'x' })
    ).rejects.toThrow(/already owned by another patch/);
  });

  it('should include binary files via binary diff', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js', 'dir/image.png']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(isBinaryFile).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/dir/a.js b/dir/a.js\n+content\n'
    );
    vi.mocked(generateBinaryFilePatch).mockResolvedValue(
      'diff --git a/dir/image.png b/dir/image.png\nGIT binary patch\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js', 'dir/image.png']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    expect(info).toHaveBeenCalledWith('Including binary file: dir/image.png');
    expect(generateFullFilePatch).toHaveBeenCalledTimes(1);
    expect(generateBinaryFilePatch).toHaveBeenCalledTimes(1);
  });

  it('should throw when directory has no changed files', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue([]);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);

    await expect(
      exportCommand('/fake/root', ['dir'], { name: 'test', category: 'ui' })
    ).rejects.toThrow('no changes to export');
  });

  it('should throw when directory has only binary files with no diff', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/image.png']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(isBinaryFile).mockResolvedValue(true);
    vi.mocked(generateBinaryFilePatch).mockResolvedValue('');

    await expect(
      exportCommand('/fake/root', ['dir'], { name: 'test', category: 'ui' })
    ).rejects.toThrow('no diff content');
  });

  it('passes directory exports through the commit helper with affected files', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/dir/a.js b/dir/a.js\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    const directoryCommit = vi.mocked(commitExportedPatch).mock.calls[0]?.[0];
    expect(directoryCommit).toMatchObject({
      patchesDir: nativePath('/fake/patches'),
      category: 'ui',
      name: 'test-dir',
      description: 'test',
      filesAffected: ['dir/a.js'],
      sourceEsrVersion: '140.9.0esr',
    });
    expect(directoryCommit?.diff).toContain('diff --git a/dir/a.js b/dir/a.js');
  });

  it('should keep single-file export behavior unchanged', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'file.js' }]);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/file.js b/file.js\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['file.js']);

    await exportCommand('/fake/root', ['file.js'], {
      name: 'test-file',
      category: 'ui',
      description: 'test',
    });

    expect(getModifiedFilesInDir).not.toHaveBeenCalled();
    expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'file.js');
  });

  it('should handle single file that is untracked', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([]);
    vi.mocked(getUntrackedFiles).mockResolvedValue(['new-file.js']);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/new-file.js b/new-file.js\nnew file mode 100644\n--- /dev/null\n+++ b/new-file.js\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['new-file.js']);

    await exportCommand('/fake/root', ['new-file.js'], {
      name: 'new-file',
      category: 'ui',
      description: 'test',
    });

    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'new-file.js');
  });

  it('should deduplicate files found in both modified and untracked lists', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js', 'dir/b.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue(['dir/b.js', 'dir/c.js']);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch).mockResolvedValue('diff --git a/x b/x\n+content\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js', 'dir/b.js', 'dir/c.js']);

    await exportCommand('/fake/root', ['dir'], {
      name: 'test-dir',
      category: 'ui',
      description: 'test',
    });

    // Should be called 3 times (a.js, b.js, c.js), not 4
    expect(generateFullFilePatch).toHaveBeenCalledTimes(3);
  });
});

describe('exportCommand - multi-path support', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should export multiple individual files into a single patch', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'a.js' },
      { status: 'M', file: 'b.js' },
    ]);
    vi.mocked(generateFullFilePatch)
      .mockResolvedValueOnce('diff --git a/a.js b/a.js\n+content a\n')
      .mockResolvedValueOnce('diff --git a/b.js b/b.js\n+content b\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js', 'b.js']);

    await exportCommand('/fake/root', ['a.js', 'b.js'], {
      name: 'multi-file',
      category: 'ui',
      description: 'test',
    });

    expect(generateFullFilePatch).toHaveBeenCalledTimes(2);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'b.js');
  });

  it('should export a mix of files and directories into a single patch', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'standalone.js' }]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch)
      .mockResolvedValueOnce('diff --git a/dir/a.js b/dir/a.js\n+content a\n')
      .mockResolvedValueOnce('diff --git a/standalone.js b/standalone.js\n+content b\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js', 'standalone.js']);

    await exportCommand('/fake/root', ['dir', 'standalone.js'], {
      name: 'mixed',
      category: 'ui',
      description: 'test',
    });

    expect(generateFullFilePatch).toHaveBeenCalledTimes(2);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'standalone.js');
  });

  it('should deduplicate files across overlapping paths', async () => {
    // Pass both a directory and a file within that directory
    vi.mocked(stat).mockImplementation((p) => {
      const pathStr = String(p);
      if (pathStr.endsWith(nativePath('/dir')) || pathStr.endsWith(nativePath('/dir/'))) {
        return Promise.resolve({ isDirectory: () => true } as Awaited<ReturnType<typeof stat>>);
      }
      return Promise.resolve({ isDirectory: () => false } as Awaited<ReturnType<typeof stat>>);
    });
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js', 'dir/b.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'dir/a.js' }]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch).mockResolvedValue('diff --git a/x b/x\n+content\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js', 'dir/b.js']);

    await exportCommand('/fake/root', ['dir', 'dir/a.js'], {
      name: 'dedup',
      category: 'ui',
      description: 'test',
    });

    // dir/a.js appears via both the directory scan and explicit path, but should only generate once
    expect(generateFullFilePatch).toHaveBeenCalledTimes(2);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/b.js');
  });

  it('should throw when one of the specified files has no changes', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'a.js' }]);
    vi.mocked(getUntrackedFiles).mockResolvedValue([]);

    await expect(
      exportCommand('/fake/root', ['a.js', 'unchanged.js'], {
        name: 'test',
        category: 'ui',
      })
    ).rejects.toThrow('unchanged.js');
  });

  it('should handle supersession across multiple input paths', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'a.js' },
      { status: 'M', file: 'b.js' },
    ]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch)
      .mockResolvedValueOnce('diff --git a/a.js b/a.js\n+content a\n')
      .mockResolvedValueOnce('diff --git a/b.js b/b.js\n+content b\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js', 'b.js']);
    vi.mocked(commitExportedPatch).mockResolvedValueOnce({
      patchFilename: '003-ui-combined.patch',
      metadata: {
        filename: '003-ui-combined.patch',
        order: 3,
        category: 'ui',
        name: 'combined',
        description: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.js', 'b.js'],
      },
      superseded: [
        { filename: '001-ui-old-a.patch', path: '/fake/patches/001-ui-old-a.patch', order: 1 },
        { filename: '002-ui-old-b.patch', path: '/fake/patches/002-ui-old-b.patch', order: 2 },
      ],
    });

    await exportCommand('/fake/root', ['a.js', 'b.js'], {
      name: 'combined',
      category: 'ui',
      description: 'test',
    });

    const combinedCommit = vi.mocked(commitExportedPatch).mock.calls[0]?.[0];
    expect(combinedCommit).toMatchObject({
      patchesDir: nativePath('/fake/patches'),
      category: 'ui',
      name: 'combined',
      description: 'test',
      filesAffected: ['a.js', 'b.js'],
      sourceEsrVersion: '140.9.0esr',
    });
    expect(combinedCommit?.diff).toContain('diff --git a/a.js b/a.js');
  });

  it('passes superseded patch information through the export commit helper', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'a.js' },
      { status: 'M', file: 'b.js' },
    ]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch)
      .mockResolvedValueOnce('diff --git a/a.js b/a.js\n+content a\n')
      .mockResolvedValueOnce('diff --git a/b.js b/b.js\n+content b\n');
    vi.mocked(extractAffectedFiles).mockReturnValue(['a.js', 'b.js']);
    vi.mocked(commitExportedPatch).mockResolvedValueOnce({
      patchFilename: '003-ui-combined.patch',
      metadata: {
        filename: '003-ui-combined.patch',
        order: 3,
        category: 'ui',
        name: 'combined',
        description: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        sourceEsrVersion: '140.9.0esr',
        filesAffected: ['a.js', 'b.js'],
      },
      superseded: [
        { filename: '001-ui-old-a.patch', path: '/fake/patches/001-ui-old-a.patch', order: 1 },
        { filename: '002-ui-old-b.patch', path: '/fake/patches/002-ui-old-b.patch', order: 2 },
      ],
    });

    await exportCommand('/fake/root', ['a.js', 'b.js'], {
      name: 'combined',
      category: 'ui',
      description: 'test',
    });

    expect(commitExportedPatch).toHaveBeenCalledTimes(1);
  });

  it('should generate binary diffs for binary files across mixed file and directory paths', async () => {
    mockStatForPaths(['dir']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['dir/a.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'image.png' }]);
    vi.mocked(isBinaryFile).mockImplementation((_repo, file) => {
      return Promise.resolve(file.endsWith('.png'));
    });
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/dir/a.js b/dir/a.js\n+content\n'
    );
    vi.mocked(generateBinaryFilePatch).mockResolvedValue('');
    vi.mocked(extractAffectedFiles).mockReturnValue(['dir/a.js']);

    await exportCommand('/fake/root', ['dir', 'image.png'], {
      name: 'mixed-binary',
      category: 'ui',
      description: 'test',
    });

    expect(warn).toHaveBeenCalledWith('Skipping binary file with no diff: image.png');
    expect(generateFullFilePatch).toHaveBeenCalledTimes(1);
    expect(generateFullFilePatch).toHaveBeenCalledWith(nativePath('/fake/engine'), 'dir/a.js');
  });
});

describe('exportCommand - single-patch supersession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to supersede exactly 1 patch in non-interactive mode', async () => {
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'file.js' }]);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/file.js b/file.js\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['file.js']);
    vi.mocked(findAllPatchesForFiles).mockResolvedValueOnce([
      {
        path: '/fake/patches/001-ui-existing.patch',
        filename: '001-ui-existing.patch',
        order: 1,
      },
    ]);

    await expect(
      exportCommand('/fake/root', ['file.js'], {
        name: 'replacement',
        category: 'ui',
        description: 'test',
      })
    ).rejects.toThrow('Refusing to supersede 1 patch');
  });
});

describe('registerExport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatForPaths([]);
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      {
        status: ' M',
        file: 'browser/base/content/browser.js',
      },
    ]);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n@@ -1 +1 @@\n-old\n+new\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/base/content/browser.js']);
  });

  it('maps parsed CLI flags onto the commitExportedPatch input', async () => {
    // One pass over every flag the export command forwards, including a
    // repeated --lint-ignore so the accumulator is exercised. The downstream
    // meaning of tier/lintIgnore is covered in re-export.test.ts and
    // end-to-end in patch-tier-and-lint-ignore.integration.test.ts.
    const program = createProgram();

    await program.parseAsync([
      'node',
      'test',
      'export',
      'browser/base/content/browser.js',
      '--name',
      'cli-export',
      '--category',
      'branding',
      '--description',
      'CLI description',
      '--supersede',
      '--tier',
      'branding',
      '--lint-ignore',
      'large-patch-files',
      '--lint-ignore',
      'large-patch-lines',
    ]);

    expect(commitExportedPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cli-export',
        category: 'branding',
        description: 'CLI description',
        sourceEsrVersion: '140.9.0esr',
        tier: 'branding',
        lintIgnore: ['large-patch-files', 'large-patch-lines'],
      })
    );
  });

  it('rejects --tier values other than "branding" at the Commander layer', async () => {
    const program = createProgram();
    // Cascade exitOverride to subcommands so Commander throws CommanderError
    // instead of calling process.exit() when the choices() validation fires.
    program.exitOverride();
    for (const cmd of program.commands) {
      cmd.exitOverride();
    }

    await expect(
      program.parseAsync([
        'node',
        'test',
        'export',
        'browser/base/content/browser.js',
        '--name',
        'invalid-tier',
        '--category',
        'ui',
        '--tier',
        'general',
      ])
    ).rejects.toThrow();

    // The handler must not have run if the choices guard rejected the
    // invocation up-front.
    expect(commitExportedPatch).not.toHaveBeenCalled();
  });
});

describe('exportCommand — engine/ prefix normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatForPaths([]);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(isGitRepository).mockResolvedValue(true);
  });

  it('accepts a repo-root-relative engine/ prefix on a file path', async () => {
    // Operator pastes the path with the `engine/` prefix (the same form
    // `register`/`test` already accept). Without the strip, export throws
    // `File "engine/browser/base/content/foo.js" has no changes to export.`
    // because status returns paths relative to engine/ and the explicit
    // prefix double-roots the candidate.
    vi.mocked(getStatusWithCodes).mockResolvedValue([
      { status: 'M', file: 'browser/base/content/fresh-extra-a.js' },
    ]);
    vi.mocked(isBinaryFile).mockResolvedValue(false);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/browser/base/content/fresh-extra-a.js b/browser/base/content/fresh-extra-a.js\n+content\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/base/content/fresh-extra-a.js']);

    await exportCommand('/fake/root', ['engine/browser/base/content/fresh-extra-a.js'], {
      name: 'fresh-extra-a',
      category: 'ui',
      description: 'prefix test',
    });

    // Once the prefix is stripped, the diff generator must see the
    // engine-relative form, exactly what git sees.
    expect(generateFullFilePatch).toHaveBeenCalledWith(
      nativePath('/fake/engine'),
      'browser/base/content/fresh-extra-a.js'
    );
    expect(commitExportedPatch).toHaveBeenCalled();
  });

  it('accepts an engine/ prefix on a directory path', async () => {
    mockStatForPaths(['browser/base/content']);
    vi.mocked(getModifiedFilesInDir).mockResolvedValue(['browser/base/content/foo.js']);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/browser/base/content/foo.js b/browser/base/content/foo.js\n+c\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/base/content/foo.js']);

    await exportCommand('/fake/root', ['engine/browser/base/content'], {
      name: 'dir-prefix',
      category: 'ui',
      description: 'dir prefix test',
    });

    expect(getModifiedFilesInDir).toHaveBeenCalledWith(
      nativePath('/fake/engine'),
      'browser/base/content'
    );
  });
});
