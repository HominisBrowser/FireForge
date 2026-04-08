// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn().mockReturnValue({
    root: '/fake/root',
    engine: '/fake/engine',
    patches: '/fake/patches',
    config: '/fake/root/fireforge.json',
    fireforgeDir: '/fake/root/.fireforge',
    state: '/fake/root/.fireforge/state.json',
    configs: '/fake/root/configs',
    src: '/fake/root/src',
    componentsDir: '/fake/root/src/components',
  }),
  loadConfig: vi.fn().mockResolvedValue({
    firefox: { version: '140.0esr' },
  }),
}));

vi.mock('../../core/git.js', () => ({
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
  getUntrackedFiles: vi.fn().mockResolvedValue([]),
  getModifiedFilesInDir: vi.fn().mockResolvedValue([]),
  getUntrackedFilesInDir: vi.fn().mockResolvedValue([]),
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
      sourceEsrVersion: '140.0esr',
      filesAffected: [],
    },
    superseded: [],
  }),
  findAllPatchesForFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-lint.js', () => ({
  lintExportedPatch: vi.fn().mockResolvedValue([]),
  detectNewFilesInDiff: vi.fn().mockReturnValue(new Set()),
  commentStyleForFile: vi.fn().mockReturnValue(null),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
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
import { pathExists } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { exportCommand, registerExport } from '../export.js';

/** Helper to create a stat mock that returns directory or file based on path */
function mockStatForPaths(dirPaths: string[]): void {
  vi.mocked(stat).mockImplementation((p) => {
    const pathStr = String(p);
    const isDir = dirPaths.some((d) => pathStr.endsWith(d));
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
      Promise.resolve(targetPath !== '/fake/engine')
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/b.js');
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
      patchesDir: '/fake/patches',
      category: 'ui',
      name: 'test-dir',
      description: 'test',
      filesAffected: ['dir/a.js'],
      sourceEsrVersion: '140.0esr',
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'file.js');
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

    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'new-file.js');
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

    // Should be called 3 times (a.js, b.js, c.js) — not 4
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'b.js');
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'standalone.js');
  });

  it('should deduplicate files across overlapping paths', async () => {
    // Pass both a directory and a file within that directory
    vi.mocked(stat).mockImplementation((p) => {
      const pathStr = String(p);
      if (pathStr.endsWith('/dir') || pathStr.endsWith('/dir/')) {
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/a.js');
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/b.js');
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
        sourceEsrVersion: '140.0esr',
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
      patchesDir: '/fake/patches',
      category: 'ui',
      name: 'combined',
      description: 'test',
      filesAffected: ['a.js', 'b.js'],
      sourceEsrVersion: '140.0esr',
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
        sourceEsrVersion: '140.0esr',
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
    expect(generateFullFilePatch).toHaveBeenCalledWith('/fake/engine', 'dir/a.js');
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
      } as { status: string; file: string },
    ]);
    vi.mocked(generateFullFilePatch).mockResolvedValue(
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js\n@@ -1 +1 @@\n-old\n+new\n'
    );
    vi.mocked(extractAffectedFiles).mockReturnValue(['browser/base/content/browser.js']);
  });

  it('routes parsed CLI arguments through the registered action', async () => {
    const program = createProgram();

    await program.parseAsync([
      'node',
      'test',
      'export',
      'browser/base/content/browser.js',
      '--name',
      'cli-export',
      '--category',
      'ui',
      '--description',
      'CLI description',
      '--supersede',
    ]);

    expect(commitExportedPatch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'cli-export',
        category: 'ui',
        description: 'CLI description',
        sourceEsrVersion: '140.0esr',
      })
    );
  });
});
