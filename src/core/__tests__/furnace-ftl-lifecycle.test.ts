// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFsMock } from '../../test-utils/module-mocks.js';
import {
  applyCustomComponent,
  applyOverrideComponent,
  computeComponentChecksums,
  undeployCustomFiles,
  undeployOverrideFiles,
} from '../furnace-apply-helpers.js';
import { createRollbackJournal } from '../furnace-rollback.js';

vi.mock('../../utils/fs.js', () => createFsMock());

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

import { nativePath } from '../../test-utils/index.js';
import { copyFile, pathExists, readText, removeFile } from '../../utils/fs.js';
import { FTL_DIR } from '../furnace-constants.js';
import { isGitRepository } from '../git.js';
import { fileExistsInHead, restoreTrackedPath } from '../git-file-ops.js';

const mockReaddir = vi.mocked(readdir);
const mockPathExists = vi.mocked(pathExists);
const mockCopyFile = vi.mocked(copyFile);
const mockReadText = vi.mocked(readText);
const mockRemoveFile = vi.mocked(removeFile);

function fakeEntry(name: string, isFile = true): import('node:fs').Dirent {
  return {
    name,
    isFile: () => isFile,
    isSymbolicLink: () => false,
  } as unknown as import('node:fs').Dirent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FTL localization lifecycle', () => {
  describe('applyCustomComponent copies FTL files to the locale directory when localized', () => {
    it('copies the FTL file to the shared Fluent tree', async () => {
      mockReaddir.mockResolvedValueOnce([
        fakeEntry('my-widget.mjs'),
        fakeEntry('my-widget.ftl'),
      ] as never);
      mockPathExists.mockResolvedValue(true);

      const result = await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'my-widget',
          componentDir: '/comp/my-widget',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/my-widget',
          register: false,
          localized: true,
        }
      );

      // The .ftl file should be copied to the FTL_DIR location
      expect(mockCopyFile).toHaveBeenCalledWith(
        nativePath('/comp/my-widget/my-widget.ftl'),
        nativePath(`/engine/${FTL_DIR}/my-widget.ftl`)
      );
      expect(result.affectedPaths).toContain(`${FTL_DIR}/my-widget.ftl`);
    });

    it('does not copy FTL when localized is false', async () => {
      mockReaddir.mockResolvedValueOnce([fakeEntry('my-widget.mjs')] as never);
      mockPathExists.mockResolvedValue(true);

      await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'my-widget',
          componentDir: '/comp/my-widget',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/my-widget',
          register: false,
          localized: false,
        }
      );

      // Only the .mjs file should be copied, no FTL copy
      const ftlCalls = mockCopyFile.mock.calls.filter((call) => call[1].endsWith('.ftl'));
      expect(ftlCalls).toHaveLength(0);
    });

    it('skips FTL copy when the .ftl source file does not exist', async () => {
      mockReaddir.mockResolvedValueOnce([fakeEntry('my-widget.mjs')] as never);
      // pathExists is called for:
      //   (1) targetDir (line 499) — returns false so ensureDir creates it
      //   (2) ftlSrc (line 537) — returns false so the copy is skipped
      mockPathExists.mockResolvedValue(false);

      await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'my-widget',
          componentDir: '/comp/my-widget',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Widget',
          targetPath: 'toolkit/content/widgets/my-widget',
          register: false,
          localized: true,
        }
      );

      const ftlCalls = mockCopyFile.mock.calls.filter((call) => call[1].endsWith('.ftl'));
      expect(ftlCalls).toHaveLength(0);
    });

    it('skips per-component .ftl copy and locale jar.mn registration when sharedFtl is set', async () => {
      // Even if a stray .ftl exists in the workspace (e.g. left behind
      // from a prior per-component layout), sharedFtl makes the shared
      // bundle authoritative and FireForge must not copy the per-component
      // file. Registering a new locale jar.mn line would either duplicate
      // the shared one or orphan the per-component entry on removal.
      mockReaddir.mockResolvedValueOnce([
        fakeEntry('mybrowser-dock-button.mjs'),
        fakeEntry('mybrowser-dock-button.ftl'),
      ] as never);
      mockPathExists.mockResolvedValue(true);

      await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'mybrowser-dock-button',
          componentDir: '/comp/mybrowser-dock-button',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Dock button',
          targetPath: 'toolkit/content/widgets/mybrowser-dock-button',
          register: false,
          localized: true,
          sharedFtl: 'browser/mybrowser-dock.ftl',
        }
      );

      const ftlCalls = mockCopyFile.mock.calls.filter((call) => call[1].endsWith('.ftl'));
      expect(ftlCalls).toHaveLength(0);
    });

    it('prunes a dangling per-widget locale jar.mn entry for a sharedFtl widget', async () => {
      // A localized sharedFtl widget can have
      // a stale `locale/@AB_CD@/toolkit/global/<name>.ftl` line — written by an
      // older FireForge — pointing at a .ftl that does not exist, so
      // `mach build` failed hard. Apply must drop that per-widget line while
      // leaving the shared bundle's own line (browser/...) intact.
      mockReaddir.mockResolvedValueOnce([fakeEntry('mybrowser-dock-button.mjs')] as never);
      mockPathExists.mockResolvedValue(true);
      mockReadText.mockResolvedValue(
        [
          '@AB_CD@.jar:',
          '  locale/@AB_CD@/browser/mybrowser-dock.ftl (%browser/mybrowser-dock.ftl)',
          '  locale/@AB_CD@/toolkit/global/mybrowser-dock-button.ftl (%toolkit/global/mybrowser-dock-button.ftl)',
        ].join('\n')
      );

      const { removeLocaleFtlJarMnEntry } = await import('../furnace-registration.js');

      const result = await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'mybrowser-dock-button',
          componentDir: '/comp/mybrowser-dock-button',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Dock button',
          targetPath: 'toolkit/content/widgets/mybrowser-dock-button',
          register: false,
          localized: true,
          sharedFtl: 'browser/mybrowser-dock.ftl',
        }
      );

      // The per-widget toolkit/global entry is pruned via removeLocaleFtlJarMnEntry;
      // the shared bundle line (browser/...) is never targeted.
      expect(removeLocaleFtlJarMnEntry).toHaveBeenCalledWith(
        '/engine',
        'toolkit/locales/jar.mn',
        'mybrowser-dock-button',
        'toolkit/global'
      );
      expect(result.affectedPaths).toContain('toolkit/locales/jar.mn');
      expect(result.stepErrors).toHaveLength(0);
    });

    it('does not touch the locale jar.mn when no dangling entry exists', async () => {
      mockReaddir.mockResolvedValueOnce([fakeEntry('mybrowser-dock-button.mjs')] as never);
      mockPathExists.mockResolvedValue(true);
      // Only the shared bundle line is present — nothing dangling to prune.
      mockReadText.mockResolvedValue(
        '@AB_CD@.jar:\n  locale/@AB_CD@/browser/mybrowser-dock.ftl (%browser/mybrowser-dock.ftl)\n'
      );

      const { removeLocaleFtlJarMnEntry } = await import('../furnace-registration.js');

      await applyCustomComponent(
        {
          engineDir: '/engine',
          name: 'mybrowser-dock-button',
          componentDir: '/comp/mybrowser-dock-button',
          ftlDir: FTL_DIR,
        },
        {
          description: 'Dock button',
          targetPath: 'toolkit/content/widgets/mybrowser-dock-button',
          register: false,
          localized: true,
          sharedFtl: 'browser/mybrowser-dock.ftl',
        }
      );

      expect(removeLocaleFtlJarMnEntry).not.toHaveBeenCalled();
    });
  });

  describe('applyOverrideComponent copies FTL files to shared Fluent tree for full overrides', () => {
    beforeEach(() => {
      mockPathExists.mockReset();
      mockPathExists.mockResolvedValue(true);
    });

    it('copies .ftl to the FTL_DIR for full override type', async () => {
      mockReaddir.mockResolvedValueOnce([
        fakeEntry('moz-card.mjs'),
        fakeEntry('moz-card.ftl'),
        fakeEntry('override.json'),
      ] as never);

      const result = await applyOverrideComponent(
        { engineDir: '/engine', name: 'moz-card', componentDir: '/comp/moz-card', ftlDir: FTL_DIR },
        {
          type: 'full',
          description: 'Full card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        }
      );

      expect(mockCopyFile).toHaveBeenCalledWith(
        nativePath('/comp/moz-card/moz-card.ftl'),
        nativePath(`/engine/${FTL_DIR}/moz-card.ftl`)
      );
      expect(result.affectedPaths).toContain(`${FTL_DIR}/moz-card.ftl`);
    });

    it('does not copy .ftl for css-only override type', async () => {
      mockReaddir.mockResolvedValueOnce([
        fakeEntry('moz-card.css'),
        fakeEntry('moz-card.ftl'),
        fakeEntry('override.json'),
      ] as never);

      const result = await applyOverrideComponent(
        { engineDir: '/engine', name: 'moz-card', componentDir: '/comp/moz-card', ftlDir: FTL_DIR },
        {
          type: 'css-only',
          description: 'CSS-only card override',
          basePath: 'toolkit/content/widgets/moz-card',
          baseVersion: '145.0',
        }
      );

      // css-only overrides only copy .css files — .ftl should not appear
      const ftlCalls = mockCopyFile.mock.calls.filter((call) => call[1].endsWith('.ftl'));
      expect(ftlCalls).toHaveLength(0);
      expect(result.affectedPaths.some((p) => p.endsWith('.ftl'))).toBe(false);
    });
  });

  describe('undeployCustomFiles removes FTL files from the locale directory', () => {
    it('removes .ftl from the shared Fluent tree, not the component targetPath', async () => {
      mockPathExists.mockResolvedValue(true);
      const journal = createRollbackJournal();

      const result = await undeployCustomFiles(
        '/engine',
        {
          description: 'Localized widget',
          targetPath: 'browser/components/widget',
          register: true,
          localized: true,
        },
        ['my-widget.ftl'],
        FTL_DIR,
        journal
      );

      expect(mockRemoveFile).toHaveBeenCalledWith(nativePath(`/engine/${FTL_DIR}/my-widget.ftl`));
      // The returned relative path should be under FTL_DIR, not the component targetPath
      expect(result[0]).toContain(FTL_DIR);
      expect(result[0]).not.toContain(nativePath('browser/components/widget'));
    });

    it('removes non-FTL files from the component targetPath', async () => {
      mockPathExists.mockResolvedValue(true);
      const journal = createRollbackJournal();

      const result = await undeployCustomFiles(
        '/engine',
        {
          description: 'Localized widget',
          targetPath: 'browser/components/widget',
          register: true,
          localized: true,
        },
        ['my-widget.css'],
        FTL_DIR,
        journal
      );

      expect(mockRemoveFile).toHaveBeenCalledWith(
        nativePath('/engine/browser/components/widget/my-widget.css')
      );
      expect(result[0]).toContain('browser/components/widget');
    });
  });

  describe('undeployOverrideFiles restores FTL files from baseline', () => {
    beforeEach(() => {
      vi.mocked(isGitRepository).mockResolvedValue(true);
      vi.mocked(fileExistsInHead).mockReset();
      vi.mocked(restoreTrackedPath).mockReset();
      mockRemoveFile.mockReset();
      mockPathExists.mockReset();
    });

    it('restores .ftl from the shared Fluent tree via git when it exists in HEAD', async () => {
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

      // FTL files route to FTL_DIR, not basePath
      expect(restoreTrackedPath).toHaveBeenCalledWith('/engine', `${FTL_DIR}/moz-card.ftl`);
      expect(result.restored).toContain(`${FTL_DIR}/moz-card.ftl`);
    });

    it('hard-deletes .ftl when it does not exist in HEAD', async () => {
      vi.mocked(fileExistsInHead).mockResolvedValue(false);
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

      expect(mockRemoveFile).toHaveBeenCalledWith(nativePath(`/engine/${FTL_DIR}/moz-card.ftl`));
      expect(result.removed).toContain(`${FTL_DIR}/moz-card.ftl`);
    });
  });

  describe('computeComponentChecksums includes FTL files', () => {
    beforeEach(() => {
      mockReaddir.mockReset();
      mockReadText.mockReset();
    });

    it('includes .ftl files in the checksum map alongside .mjs and .css', async () => {
      mockReaddir.mockResolvedValueOnce([
        fakeEntry('comp.mjs'),
        fakeEntry('comp.css'),
        fakeEntry('comp.ftl'),
        fakeEntry('override.json'),
        fakeEntry('readme.md'),
      ] as never);
      mockReadText.mockResolvedValue('content');

      const result = await computeComponentChecksums('/comp');

      expect(Object.keys(result).sort()).toEqual(['comp.css', 'comp.ftl', 'comp.mjs']);
      // override.json and readme.md should be excluded
      expect(result).not.toHaveProperty('override.json');
      expect(result).not.toHaveProperty('readme.md');
    });

    it('produces a stable hash for .ftl content', async () => {
      mockReaddir.mockResolvedValueOnce([fakeEntry('comp.ftl')] as never);
      mockReadText.mockResolvedValueOnce('localization-key = Translated value');

      const first = await computeComponentChecksums('/comp');

      mockReaddir.mockResolvedValueOnce([fakeEntry('comp.ftl')] as never);
      mockReadText.mockResolvedValueOnce('localization-key = Translated value');

      const second = await computeComponentChecksums('/comp');

      expect(first['comp.ftl']).toBe(second['comp.ftl']);
      expect(first['comp.ftl']).toBeDefined();
    });

    it('normalizes BOM and CRLF in .ftl files before hashing', async () => {
      mockReaddir.mockResolvedValueOnce([fakeEntry('comp.ftl')] as never);
      mockReadText.mockResolvedValueOnce('\uFEFFkey = value\r\n');

      const withBom = await computeComponentChecksums('/comp');

      mockReaddir.mockResolvedValueOnce([fakeEntry('comp.ftl')] as never);
      mockReadText.mockResolvedValueOnce('key = value\n');

      const withoutBom = await computeComponentChecksums('/comp');

      expect(withBom['comp.ftl']).toBe(withoutBom['comp.ftl']);
    });
  });
});
