// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  diffDeletedFiles,
  extractComponentChecksums,
  hasComponentChanged,
  prefixChecksums,
  restoreOverrideFileToBaseline,
  undeployCustomFiles,
  undeployOverrideFiles,
} from '../furnace-apply-helpers.js';
import { createRollbackJournal } from '../furnace-rollback.js';

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  copyFile: vi.fn(),
  ensureDir: vi.fn(),
  removeFile: vi.fn(),
}));

vi.mock('../furnace-registration.js', () => ({
  addCustomElementRegistration: vi.fn(),
  addJarMnEntries: vi.fn(),
  addLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve(0)),
  removeLocaleFtlJarMnEntry: vi.fn(() => Promise.resolve()),
  validateCustomElementRegistration: vi.fn(),
  validateJarMnInsertionForFiles: vi.fn(),
}));

vi.mock('../git.js', () => ({
  isGitRepository: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../git-file-ops.js', () => ({
  fileExistsInHead: vi.fn(),
  restoreTrackedPath: vi.fn(),
}));

// Stub the journal module so the new undeploy tests don't have to set up
// real fs reads inside snapshotFile. The existing apply tests don't touch
// snapshotFile from this test file because they pass `undefined` as the
// rollback journal, so this stub is only needed for the new test groups.
vi.mock('../furnace-rollback.js', () => ({
  createRollbackJournal: vi.fn(() => ({
    files: new Map(),
    createdDirs: new Set(),
    skippedSymlinks: new Set(),
  })),
  recordCreatedDir: vi.fn(),
  snapshotFile: vi.fn(() => Promise.resolve()),
  snapshotDir: vi.fn(() => Promise.resolve()),
}));

import { readdir } from 'node:fs/promises';
vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(),
}));

import { copyFile, ensureDir, pathExists, readText, removeFile } from '../../utils/fs.js';
import { FTL_DIR } from '../furnace-constants.js';
import {
  addCustomElementRegistration,
  addJarMnEntries,
  validateCustomElementRegistration,
  validateJarMnInsertionForFiles,
} from '../furnace-registration.js';
import { isGitRepository } from '../git.js';
import { fileExistsInHead, restoreTrackedPath } from '../git-file-ops.js';

const mockReaddir = vi.mocked(readdir);
const mockPathExists = vi.mocked(pathExists);
const mockReadText = vi.mocked(readText);
const mockCopyFile = vi.mocked(copyFile);
const mockEnsureDir = vi.mocked(ensureDir);
const mockAddCEReg = vi.mocked(addCustomElementRegistration);
const mockAddJarMn = vi.mocked(addJarMnEntries);
const mockValidateCEReg = vi.mocked(validateCustomElementRegistration);
const mockValidateJarMn = vi.mocked(validateJarMnInsertionForFiles);

function fakeEntry(name: string, isFile = true): import('node:fs').Dirent {
  return {
    name,
    isFile: () => isFile,
    isSymbolicLink: () => false,
  } as unknown as import('node:fs').Dirent;
}

function fakeSymlink(name: string): import('node:fs').Dirent {
  return {
    name,
    isFile: () => true,
    isSymbolicLink: () => true,
  } as unknown as import('node:fs').Dirent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeComponentChecksums', () => {
  it('checksums .mjs, .css, and .ftl files', async () => {
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('comp.mjs'),
      fakeEntry('comp.css'),
      fakeEntry('comp.ftl'),
      fakeEntry('override.json'),
      fakeEntry('readme.md'),
    ] as never);
    mockReadText.mockResolvedValue('content');

    const result = await computeComponentChecksums('/comp');

    expect(Object.keys(result)).toEqual(['comp.mjs', 'comp.css', 'comp.ftl']);
    expect(mockReadText).toHaveBeenCalledTimes(3);
  });

  it('skips directories', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('sub', false)] as never);

    const result = await computeComponentChecksums('/comp');

    expect(Object.keys(result)).toHaveLength(0);
  });

  it('normalizes BOM and CRLF before hashing', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValueOnce('\uFEFFline1\r\nline2');

    const withBom = await computeComponentChecksums('/comp');

    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValueOnce('line1\nline2');

    const withoutBom = await computeComponentChecksums('/comp');

    expect(withBom['comp.mjs']).toBe(withoutBom['comp.mjs']);
  });
});

describe('hasComponentChanged', () => {
  it('returns false when checksums match', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValue('content');

    // Get current checksums first
    const checksums = await computeComponentChecksums('/comp');

    mockReaddir.mockResolvedValueOnce([fakeEntry('comp.mjs')] as never);
    mockReadText.mockResolvedValue('content');

    const changed = await hasComponentChanged('/comp', checksums);
    expect(changed).toBe(false);
  });

  it('returns true when file count differs', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('a.mjs'), fakeEntry('b.css')] as never);
    mockReadText.mockResolvedValue('content');

    const changed = await hasComponentChanged('/comp', { 'a.mjs': 'hash1' });
    expect(changed).toBe(true);
  });

  it('returns true when hash differs', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('a.mjs')] as never);
    mockReadText.mockResolvedValue('new content');

    const changed = await hasComponentChanged('/comp', { 'a.mjs': 'old-hash' });
    expect(changed).toBe(true);
  });
});

describe('extractComponentChecksums', () => {
  it('extracts prefixed checksums for a component', () => {
    const all = {
      'custom/btn/btn.mjs': 'hash1',
      'custom/btn/btn.css': 'hash2',
      'override/card/card.css': 'hash3',
    };

    const result = extractComponentChecksums(all, 'custom', 'btn');

    expect(result).toEqual({ 'btn.mjs': 'hash1', 'btn.css': 'hash2' });
  });

  it('returns empty object for undefined input', () => {
    expect(extractComponentChecksums(undefined, 'custom', 'btn')).toEqual({});
  });
});

describe('prefixChecksums', () => {
  it('adds type/name/ prefix to all keys', () => {
    const result = prefixChecksums({ 'a.mjs': 'h1', 'b.css': 'h2' }, 'custom', 'btn');

    expect(result).toEqual({
      'custom/btn/a.mjs': 'h1',
      'custom/btn/b.css': 'h2',
    });
  });
});

describe('applyCustomComponent', () => {
  it('rejects invalid component names', async () => {
    await expect(
      applyCustomComponent(
        '/engine',
        'INVALID',
        '/comp',
        {
          description: 'test',
          targetPath: 'toolkit/content/widgets/invalid',
          register: false,
          localized: false,
        },
        FTL_DIR
      )
    ).rejects.toThrow('Invalid component name');
  });

  it('copies .mjs and .css files in live mode', async () => {
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('my-btn.mjs'),
      fakeEntry('my-btn.css'),
      fakeEntry('readme.md'),
    ] as never);

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: false,
        localized: false,
      },
      FTL_DIR
    );

    expect(mockEnsureDir).toHaveBeenCalled();
    expect(mockCopyFile).toHaveBeenCalledTimes(2);
    // 2 copied files + jar.mn entry = 3 affected paths
    expect(result.affectedPaths).toHaveLength(3);
    expect(result.stepErrors).toHaveLength(0);
  });

  it('registers in customElements.js when register is true', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);

    await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      FTL_DIR
    );

    expect(mockAddCEReg).toHaveBeenCalledWith(
      '/engine',
      'my-btn',
      'chrome://global/content/elements/my-btn.mjs',
      {}
    );
    expect(mockAddJarMn).toHaveBeenCalled();
  });

  it('collects step errors without throwing', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockAddCEReg.mockRejectedValueOnce(new Error('parse error'));

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      FTL_DIR
    );

    expect(result.stepErrors).toHaveLength(1);
    expect(result.stepErrors[0]?.step).toBe('customElements.js registration');
  });

  it('copies .ftl file when localized', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockPathExists.mockResolvedValue(true);

    await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: false,
        localized: true,
      },
      FTL_DIR
    );

    // 1 .mjs copy + 1 .ftl copy
    expect(mockCopyFile).toHaveBeenCalledTimes(2);
  });

  it('returns dry-run actions without copying', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs'), fakeEntry('my-btn.css')] as never);
    mockPathExists.mockResolvedValue(false);

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      FTL_DIR,
      true
    );

    expect(result.actions).toBeDefined();
    expect(result.affectedPaths).toHaveLength(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('surfaces registration validation errors during dry-run', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs'), fakeEntry('my-btn.css')] as never);
    mockPathExists.mockResolvedValue(false);
    mockValidateCEReg.mockRejectedValueOnce(new Error('no DOMContentLoaded block'));

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      FTL_DIR,
      true
    );

    expect(result.stepErrors).toHaveLength(1);
    expect(result.stepErrors[0]?.step).toBe('customElements.js registration');
    expect(result.stepErrors[0]?.error).toContain('no DOMContentLoaded block');
    expect(result.actions).toBeDefined();
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('surfaces jar.mn validation errors during dry-run', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockPathExists.mockResolvedValue(false);
    mockValidateJarMn.mockRejectedValueOnce(new Error('jar.mn is empty'));

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: false,
        localized: false,
      },
      FTL_DIR,
      true
    );

    expect(result.stepErrors).toHaveLength(1);
    expect(result.stepErrors[0]?.step).toBe('jar.mn registration');
    expect(result.stepErrors[0]?.error).toContain('jar.mn is empty');
  });

  it('reports no step errors during dry-run when validation passes', async () => {
    mockReaddir.mockResolvedValueOnce([fakeEntry('my-btn.mjs')] as never);
    mockPathExists.mockResolvedValue(false);
    mockValidateCEReg.mockResolvedValueOnce(undefined);
    mockValidateJarMn.mockResolvedValueOnce(undefined);

    const result = await applyCustomComponent(
      '/engine',
      'my-btn',
      '/comp/my-btn',
      {
        description: 'Button',
        targetPath: 'toolkit/content/widgets/my-btn',
        register: true,
        localized: false,
      },
      FTL_DIR,
      true
    );

    expect(result.stepErrors).toHaveLength(0);
  });
});

describe('applyOverrideComponent', () => {
  it('throws when target path does not exist', async () => {
    mockPathExists.mockResolvedValue(false);

    await expect(
      applyOverrideComponent(
        '/engine',
        'moz-card',
        '/comp/moz-card',
        {
          type: 'css-only',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
        FTL_DIR
      )
    ).rejects.toThrow('Override target path not found');
  });

  it('copies only CSS files for css-only overrides', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeEntry('moz-card.mjs'),
      fakeEntry('override.json'),
    ] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR
    );

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(result.affectedPaths).toHaveLength(1);
  });

  it('copies .mjs and .css for full overrides', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeEntry('moz-card.mjs'),
      fakeEntry('override.json'),
    ] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'full',
        description: 'Full override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR
    );

    expect(mockCopyFile).toHaveBeenCalledTimes(2);
    expect(result.affectedPaths).toHaveLength(2);
  });

  it('copies .ftl files for full overrides into the shared Fluent tree', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeEntry('moz-card.mjs'),
      fakeEntry('moz-card.ftl'),
      fakeEntry('override.json'),
    ] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'full',
        description: 'Full override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR
    );

    expect(mockCopyFile).toHaveBeenCalledWith(
      '/comp/moz-card/moz-card.ftl',
      '/engine/toolkit/locales/en-US/toolkit/global/moz-card.ftl'
    );
    expect(result.affectedPaths).toContain('toolkit/locales/en-US/toolkit/global/moz-card.ftl');
  });

  it('throws when no matching files are found', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([fakeEntry('readme.md')] as never);

    await expect(
      applyOverrideComponent(
        '/engine',
        'moz-card',
        '/comp/moz-card',
        {
          type: 'css-only',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
        FTL_DIR
      )
    ).rejects.toThrow('No matching files');
  });

  it('returns dry-run actions without copying', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([fakeEntry('moz-card.css')] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR,
      true
    );

    expect(result.actions).toBeDefined();
    expect(result.affectedPaths).toHaveLength(0);
    expect(mockCopyFile).not.toHaveBeenCalled();
  });

  it('plans .ftl copies into the shared Fluent tree during dry-run', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([fakeEntry('moz-card.ftl')] as never);

    const result = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'full',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR,
      true
    );

    expect(result.actions?.[0]?.target).toBe(
      '/engine/toolkit/locales/en-US/toolkit/global/moz-card.ftl'
    );
  });
});

describe('diffDeletedFiles', () => {
  it('returns filenames in previous but not current', () => {
    expect(
      diffDeletedFiles(
        { 'a.mjs': 'h1', 'a.css': 'h2', 'a.ftl': 'h3' },
        { 'a.mjs': 'h1', 'a.ftl': 'h3' }
      )
    ).toEqual(['a.css']);
  });

  it('returns an empty array when nothing was deleted', () => {
    expect(diffDeletedFiles({ 'a.mjs': 'h1' }, { 'a.mjs': 'h1', 'a.css': 'h2' })).toEqual([]);
  });

  it('returns deletions sorted alphabetically for stable output', () => {
    expect(diffDeletedFiles({ 'z.css': 'h', 'a.css': 'h', 'm.mjs': 'h' }, {})).toEqual([
      'a.css',
      'm.mjs',
      'z.css',
    ]);
  });
});

describe('restoreOverrideFileToBaseline', () => {
  beforeEach(() => {
    vi.mocked(fileExistsInHead).mockReset();
    vi.mocked(restoreTrackedPath).mockReset();
    vi.mocked(removeFile).mockReset();
    mockPathExists.mockReset();
  });

  it('restores files that exist in HEAD via git restore', async () => {
    vi.mocked(fileExistsInHead).mockResolvedValue(true);
    const journal = createRollbackJournal();
    mockPathExists.mockResolvedValue(true);

    const action = await restoreOverrideFileToBaseline(
      '/engine',
      '/engine/toolkit/content/widgets/foo/foo.css',
      journal
    );

    expect(action).toBe('restored');
    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/engine',
      'toolkit/content/widgets/foo/foo.css'
    );
    expect(removeFile).not.toHaveBeenCalled();
  });

  it('hard-deletes files that the override introduced (not in HEAD)', async () => {
    vi.mocked(fileExistsInHead).mockResolvedValue(false);
    mockPathExists.mockResolvedValue(true);
    const journal = createRollbackJournal();

    const action = await restoreOverrideFileToBaseline(
      '/engine',
      '/engine/toolkit/content/widgets/foo/intro.css',
      journal
    );

    expect(action).toBe('removed');
    expect(removeFile).toHaveBeenCalledWith('/engine/toolkit/content/widgets/foo/intro.css');
  });

  it('returns noop when neither HEAD nor disk has the file', async () => {
    vi.mocked(fileExistsInHead).mockResolvedValue(false);
    mockPathExists.mockResolvedValue(false);
    const journal = createRollbackJournal();

    const action = await restoreOverrideFileToBaseline(
      '/engine',
      '/engine/toolkit/content/widgets/foo/missing.css',
      journal
    );

    expect(action).toBe('noop');
    expect(removeFile).not.toHaveBeenCalled();
  });
});

describe('undeployCustomFiles', () => {
  beforeEach(() => {
    vi.mocked(removeFile).mockReset();
    mockPathExists.mockReset();
  });

  it('removes deleted files from the component target path', async () => {
    mockPathExists.mockResolvedValue(true);
    const journal = createRollbackJournal();

    const result = await undeployCustomFiles(
      '/engine',
      {
        description: 'Panel',
        targetPath: 'browser/components/panel',
        register: true,
        localized: false,
      },
      ['moz-panel.css'],
      FTL_DIR,
      journal
    );

    expect(removeFile).toHaveBeenCalledWith('/engine/browser/components/panel/moz-panel.css');
    expect(result).toEqual(['browser/components/panel/moz-panel.css']);
  });

  it('removes .ftl files from the shared Fluent tree, not the target path', async () => {
    mockPathExists.mockResolvedValue(true);
    const journal = createRollbackJournal();

    const result = await undeployCustomFiles(
      '/engine',
      {
        description: 'Localized',
        targetPath: 'browser/components/loc',
        register: true,
        localized: true,
      },
      ['moz-loc.ftl'],
      FTL_DIR,
      journal
    );

    // FTL goes under FTL_DIR, not the component's targetPath.
    expect(removeFile).toHaveBeenCalledWith(expect.stringContaining('moz-loc.ftl'));
    expect(result[0]).toContain('moz-loc.ftl');
    expect(result[0]).not.toContain('browser/components/loc');
  });

  it('is a no-op when an engine file is already missing', async () => {
    mockPathExists.mockResolvedValue(false);
    const journal = createRollbackJournal();

    const result = await undeployCustomFiles(
      '/engine',
      {
        description: 'Panel',
        targetPath: 'browser/components/panel',
        register: true,
        localized: false,
      },
      ['moz-panel.css'],
      FTL_DIR,
      journal
    );

    expect(removeFile).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

describe('undeployOverrideFiles', () => {
  beforeEach(() => {
    vi.mocked(fileExistsInHead).mockReset();
    vi.mocked(restoreTrackedPath).mockReset();
    vi.mocked(removeFile).mockReset();
    vi.mocked(isGitRepository).mockReset();
    vi.mocked(isGitRepository).mockResolvedValue(true);
    mockPathExists.mockReset();
  });

  it('routes each deleted file through restoreOverrideFileToBaseline', async () => {
    vi.mocked(fileExistsInHead).mockResolvedValue(true);
    mockPathExists.mockResolvedValue(true);
    const journal = createRollbackJournal();

    const result = await undeployOverrideFiles(
      '/engine',
      {
        type: 'full',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      ['moz-card.css'],
      FTL_DIR,
      journal
    );

    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/engine',
      'toolkit/content/widgets/moz-card/moz-card.css'
    );
    expect(result.restored).toContain('toolkit/content/widgets/moz-card/moz-card.css');
  });

  it('restores deleted override Fluent files from the shared localization tree', async () => {
    vi.mocked(fileExistsInHead).mockResolvedValue(true);
    mockPathExists.mockResolvedValue(true);
    const journal = createRollbackJournal();

    const result = await undeployOverrideFiles(
      '/engine',
      {
        type: 'full',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      ['moz-card.ftl'],
      FTL_DIR,
      journal
    );

    expect(restoreTrackedPath).toHaveBeenCalledWith(
      '/engine',
      'toolkit/locales/en-US/toolkit/global/moz-card.ftl'
    );
    expect(result.restored).toContain('toolkit/locales/en-US/toolkit/global/moz-card.ftl');
  });

  it('refuses to run without a rollback journal', async () => {
    await expect(
      undeployOverrideFiles(
        '/engine',
        {
          type: 'full',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
        ['moz-card.css'],
        FTL_DIR
      )
    ).rejects.toThrow(/rollback journal/);
  });

  it('refuses to run when the engine is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValue(false);
    const journal = createRollbackJournal();
    await expect(
      undeployOverrideFiles(
        '/engine',
        {
          type: 'full',
          description: 'Card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        },
        ['moz-card.css'],
        FTL_DIR,
        journal
      )
    ).rejects.toThrow(/not a git repository/);
  });

  it('returns empty result when nothing was deleted', async () => {
    const journal = createRollbackJournal();
    const result = await undeployOverrideFiles(
      '/engine',
      {
        type: 'full',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      [],
      FTL_DIR,
      journal
    );
    expect(result).toEqual({ restored: [], removed: [] });
    expect(restoreTrackedPath).not.toHaveBeenCalled();
  });
});

describe('symlink handling', () => {
  it('computeComponentChecksums skips symlinks pointing to component files', async () => {
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('comp.mjs'),
      fakeSymlink('link.mjs'),
      fakeEntry('comp.css'),
    ] as never);
    mockReadText.mockResolvedValue('content');

    const result = await computeComponentChecksums('/comp');

    expect(Object.keys(result)).toEqual(['comp.mjs', 'comp.css']);
    expect(mockReadText).toHaveBeenCalledTimes(2);
  });

  it('applyCustomComponent skips symlinks during file copy', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-panel.mjs'),
      fakeSymlink('link.mjs'),
    ] as never);

    await applyCustomComponent(
      '/engine',
      'moz-panel',
      '/comp/moz-panel',
      {
        description: 'Panel',
        targetPath: 'browser/components/panel',
        register: false,
        localized: false,
      },
      FTL_DIR
    );

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(mockCopyFile).toHaveBeenCalledWith('/comp/moz-panel/moz-panel.mjs', expect.any(String));
  });

  it('applyOverrideComponent skips symlinks during file copy', async () => {
    mockPathExists.mockResolvedValue(true);
    mockReaddir.mockResolvedValueOnce([
      fakeEntry('moz-card.css'),
      fakeSymlink('link.css'),
    ] as never);

    const { affectedPaths } = await applyOverrideComponent(
      '/engine',
      'moz-card',
      '/comp/moz-card',
      {
        type: 'css-only',
        description: 'Card override',
        basePath: 'toolkit/content/widgets/moz-card',
        baseVersion: '145.0',
      },
      FTL_DIR
    );

    expect(mockCopyFile).toHaveBeenCalledTimes(1);
    expect(affectedPaths).toHaveLength(1);
  });
});
