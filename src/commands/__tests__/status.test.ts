// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { getStatusWithCodes, isGitRepository } from '../../core/git.js';
import { getUntrackedFilesInDir } from '../../core/git-status.js';
import { isFileRegistered, matchesRegistrablePattern } from '../../core/manifest-rules.js';
import { computePatchedContent } from '../../core/patch-apply.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { DEFAULT_CONFIG } from '../../test-utils/index.js';
import { pathExists, readText } from '../../utils/fs.js';
import { info, intro, outro, warn } from '../../utils/logger.js';
import { statusCommand } from '../status.js';

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
    componentsDir: '/fake/root/components',
  }),
  loadConfig: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  getStatusWithCodes: vi.fn(),
  isGitRepository: vi.fn(),
}));

vi.mock('../../core/git-status.js', () => ({
  getUntrackedFilesInDir: vi.fn(),
}));

vi.mock('../../core/manifest-rules.js', () => ({
  matchesRegistrablePattern: vi.fn(),
  isFileRegistered: vi.fn(),
}));

vi.mock('../../core/patch-apply.js', () => ({
  computePatchedContent: vi.fn(),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

describe('statusCommand', () => {
  const projectRoot = '/fake/root';

  function infoMessages(): string[] {
    return vi.mocked(info).mock.calls.map(([message]) => message);
  }

  function warnMessages(): string[] {
    return vi.mocked(warn).mock.calls.map(([message]) => message);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue({
      root: '/fake/root',
      engine: '/fake/engine',
      patches: '/fake/patches',
      config: '/fake/root/fireforge.json',
      fireforgeDir: '/fake/root/.fireforge',
      state: '/fake/root/.fireforge/state.json',
      configs: '/fake/root/configs',
      src: '/fake/root/src',
      componentsDir: '/fake/root/components',
    });
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue(DEFAULT_CONFIG);
    vi.mocked(matchesRegistrablePattern).mockReturnValue(false);
    vi.mocked(isFileRegistered).mockResolvedValue(false);
    vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
    vi.mocked(loadPatchesManifest).mockResolvedValue(null);
    vi.mocked(computePatchedContent).mockResolvedValue(null);
    vi.mocked(readText).mockResolvedValue('');
  });

  describe('default mode (patch-aware)', () => {
    it('fails on missing fireforge.json before checking engine state', async () => {
      vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Config not found'));
      vi.mocked(pathExists).mockResolvedValue(false);

      await expect(statusCommand(projectRoot)).rejects.toThrow('Config not found');
      expect(isGitRepository).not.toHaveBeenCalled();
    });

    it('shows unmanaged changes when no patches manifest exists', async () => {
      vi.mocked(matchesRegistrablePattern).mockImplementation(
        (file) => file === 'browser/base/content/example.js'
      );

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/components/example.cpp' },
        { status: '??', file: 'browser/base/content/example.js' },
      ]);

      await statusCommand(projectRoot);

      expect(intro).toHaveBeenCalledWith('FireForge Status');
      expect(infoMessages()).toContain('2 modified files:\n');
      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).toContain('modified:');
      expect(warnMessages()).toContain('untracked:');
      expect(warnMessages()).toContain('Potentially unregistered files:');
      expect(warnMessages()).not.toContain('Tool-managed branding changes:');
      expect(infoMessages()).toContain(
        "  browser/base/content/example.js — run 'fireforge register browser/base/content/example.js'"
      );
      expect(outro).toHaveBeenCalledWith('2 unmanaged');
    });

    it('shows branding-only changes in tool-managed section', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'browser/moz.configure' },
        { status: 'M', file: 'browser/branding/mybrowser/locales/en-US/brand.ftl' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(warnMessages()).toContain('modified:');
      expect(infoMessages()).toContain('  browser/moz.configure');
      expect(infoMessages()).toContain('  browser/branding/mybrowser/locales/en-US/brand.ftl');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(warnMessages()).not.toContain('Potentially unregistered files:');
      expect(outro).toHaveBeenCalledWith('2 branding');
    });

    it('shows unmanaged changes and branding changes in separate sections', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/components/example.cpp' },
        { status: 'A', file: 'browser/branding/mybrowser/configure.sh' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(infoMessages()).toContain('  toolkit/components/example.cpp');
      expect(infoMessages()).toContain('  browser/branding/mybrowser/configure.sh');
    });

    it('classifies an untracked branding directory as tool-managed branding', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/branding/mybrowser/' },
      ]);
      vi.mocked(getUntrackedFilesInDir).mockResolvedValue([
        'browser/branding/mybrowser/configure.sh',
        'browser/branding/mybrowser/locales/en-US/brand.ftl',
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(warnMessages()).toContain('untracked:');
      expect(infoMessages()).toContain('  browser/branding/mybrowser/configure.sh');
      expect(infoMessages()).toContain('  browser/branding/mybrowser/locales/en-US/brand.ftl');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(outro).toHaveBeenCalledWith('2 branding');
    });

    it('always classifies browser/moz.configure as branding-managed', async () => {
      vi.mocked(matchesRegistrablePattern).mockImplementation(
        (file) => file === 'browser/base/content/example.js'
      );

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'browser/moz.configure' },
        { status: '??', file: 'browser/base/content/example.js' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(infoMessages()).toContain('  browser/moz.configure');
      expect(warnMessages()).toContain('Potentially unregistered files:');
      expect(infoMessages()).toContain(
        "  browser/base/content/example.js — run 'fireforge register browser/base/content/example.js'"
      );
    });

    it('classifies patch-backed file when content matches expected', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-sidebar.patch',
            order: 1,
            category: 'ui',
            name: 'sidebar',
            description: 'Sidebar changes',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/foo.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('expected content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'toolkit/foo.cpp' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(infoMessages()).toContain('  toolkit/foo.cpp');
      expect(outro).toHaveBeenCalledWith('1 patch-backed');
    });

    it('classifies all files from a multi-file patch as patch-backed', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '003-infra-flush-manager.patch',
            order: 3,
            category: 'infra',
            name: 'flush-manager',
            description: 'Flush manager with helper',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['modules/FlushManager.sys.mjs', 'modules/FlushHelper.sys.mjs'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('expected content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'modules/FlushManager.sys.mjs' },
        { status: '??', file: 'modules/FlushHelper.sys.mjs' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(infoMessages()).toContain('  modules/FlushManager.sys.mjs');
      expect(infoMessages()).toContain('  modules/FlushHelper.sys.mjs');
      expect(outro).toHaveBeenCalledWith('2 patch-backed');
    });

    it('classifies patch-touched file as unmanaged when content diverges', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-sidebar.patch',
            order: 1,
            category: 'ui',
            name: 'sidebar',
            description: 'Sidebar changes',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/foo.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('different actual content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'toolkit/foo.cpp' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).not.toContain('Patch-backed materialized changes:');
      expect(infoMessages()).toContain('  toolkit/foo.cpp');
      expect(outro).toHaveBeenCalledWith('1 unmanaged');
    });

    it('shows all three buckets when files span categories', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-sidebar.patch',
            order: 1,
            category: 'ui',
            name: 'sidebar',
            description: 'Sidebar changes',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/patched.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('matched content');
      vi.mocked(readText).mockResolvedValue('matched content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/unmanaged.cpp' },
        { status: 'M', file: 'toolkit/patched.cpp' },
        { status: 'M', file: 'browser/moz.configure' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(outro).toHaveBeenCalledWith('1 unmanaged, 1 patch-backed, 1 branding');
    });

    it('classifies deleted file as patch-backed when patch expects deletion', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-infra-cleanup.patch',
            order: 1,
            category: 'infra',
            name: 'cleanup',
            description: 'Remove old file',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/old.cpp'],
          },
        ],
      });
      // computePatchedContent returns null → file should not exist after patches
      vi.mocked(computePatchedContent).mockResolvedValue(null);

      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'D', file: 'toolkit/old.cpp' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
    });

    it('classifies deleted file as unmanaged when patch expects modification', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-change.patch',
            order: 1,
            category: 'ui',
            name: 'change',
            description: 'Modify file',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/modified.cpp'],
          },
        ],
      });
      // computePatchedContent returns content → file should exist after patches
      vi.mocked(computePatchedContent).mockResolvedValue('modified content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'D', file: 'toolkit/modified.cpp' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).not.toContain('Patch-backed materialized changes:');
    });

    it('omits empty buckets', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-sidebar.patch',
            order: 1,
            category: 'ui',
            name: 'sidebar',
            description: 'Sidebar changes',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/foo.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('content');
      vi.mocked(readText).mockResolvedValue('content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'toolkit/foo.cpp' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).not.toContain('Tool-managed branding changes:');
    });
  });

  describe('--raw mode', () => {
    it('outputs porcelain-style tab-separated lines', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/components/example.cpp' },
        { status: '??', file: 'browser/base/content/example.js' },
      ]);

      await statusCommand(projectRoot, { raw: true });

      expect(writeSpy).toHaveBeenCalledWith('M\ttoolkit/components/example.cpp\n');
      expect(writeSpy).toHaveBeenCalledWith('??\tbrowser/base/content/example.js\n');
      writeSpy.mockRestore();
    });

    it('outputs branding files in raw mode without decoration', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'browser/moz.configure' },
        { status: 'M', file: 'browser/branding/mybrowser/locales/en-US/brand.ftl' },
      ]);

      await statusCommand(projectRoot, { raw: true });

      expect(writeSpy).toHaveBeenCalledWith('M\tbrowser/moz.configure\n');
      expect(writeSpy).toHaveBeenCalledWith(
        'M\tbrowser/branding/mybrowser/locales/en-US/brand.ftl\n'
      );
      writeSpy.mockRestore();
    });

    it('does not call patch classification functions', async () => {
      const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'toolkit/foo.cpp' }]);

      await statusCommand(projectRoot, { raw: true });

      expect(loadPatchesManifest).not.toHaveBeenCalled();
      expect(computePatchedContent).not.toHaveBeenCalled();
      writeSpy.mockRestore();
    });
  });

  describe('--unmanaged mode', () => {
    it('shows only unmanaged changes', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-sidebar.patch',
            order: 1,
            category: 'ui',
            name: 'sidebar',
            description: 'Sidebar changes',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['toolkit/patched.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('content');
      vi.mocked(readText).mockResolvedValue('content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/unmanaged.cpp' },
        { status: 'M', file: 'toolkit/patched.cpp' },
        { status: 'M', file: 'browser/moz.configure' },
      ]);

      await statusCommand(projectRoot, { unmanaged: true });

      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(warnMessages()).not.toContain('Patch-backed materialized changes:');
      expect(warnMessages()).not.toContain('Tool-managed branding changes:');
      expect(warnMessages()).toContain('modified:');
      expect(infoMessages()).toContain('  toolkit/unmanaged.cpp');
      expect(infoMessages()).not.toContain('  toolkit/patched.cpp');
      expect(infoMessages()).not.toContain('  browser/moz.configure');
      // Header shows unmanaged count, not total
      expect(infoMessages()).toContainEqual(expect.stringContaining('1 unmanaged file'));
      expect(infoMessages()).toContainEqual(expect.stringContaining('3 total modified'));
      expect(outro).toHaveBeenCalledWith('1 unmanaged change');
    });

    it('shows no unmanaged changes message when all are managed', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'browser/moz.configure' },
      ]);

      await statusCommand(projectRoot, { unmanaged: true });

      expect(infoMessages()).toContain('No unmanaged changes');
      expect(outro).toHaveBeenCalledWith('No unmanaged changes');
    });
  });

  describe('flag validation', () => {
    it('throws when both --raw and --unmanaged are provided', async () => {
      await expect(statusCommand(projectRoot, { raw: true, unmanaged: true })).rejects.toThrow(
        'Cannot use --raw and --unmanaged together.'
      );
    });
  });

  describe('registration warnings', () => {
    it('warns for a new registrable file that is not yet registered', async () => {
      vi.mocked(matchesRegistrablePattern).mockImplementation(
        (file) => file === 'browser/themes/shared/new-tokens.css'
      );
      vi.mocked(isFileRegistered).mockResolvedValue(false);
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/themes/shared/new-tokens.css' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Potentially unregistered files:');
      expect(infoMessages()).toContain(
        "  browser/themes/shared/new-tokens.css — run 'fireforge register browser/themes/shared/new-tokens.css'"
      );
    });

    it('does not warn for a new registrable file that is already registered', async () => {
      vi.mocked(matchesRegistrablePattern).mockImplementation(
        (file) => file === 'browser/themes/shared/mybrowser-tokens.css'
      );
      vi.mocked(isFileRegistered).mockResolvedValue(true);
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/themes/shared/mybrowser-tokens.css' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).not.toContain('Potentially unregistered files:');
    });

    it('does not warn for a new non-registrable file', async () => {
      vi.mocked(matchesRegistrablePattern).mockReturnValue(false);
      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: '??', file: 'docs/notes.txt' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).not.toContain('Potentially unregistered files:');
      expect(isFileRegistered).not.toHaveBeenCalled();
    });
  });

  describe('untracked directory expansion', () => {
    it('expands untracked directory and classifies individual files against patches', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/modules/mybrowser/' },
      ]);
      vi.mocked(getUntrackedFilesInDir).mockResolvedValue([
        'browser/modules/mybrowser/MybrowserFacade.sys.mjs',
        'browser/modules/mybrowser/test/browser_mybrowser_facade_init.js',
        'browser/modules/mybrowser/unrelated.txt',
      ]);
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '010-infra-storage-facade.patch',
            order: 10,
            category: 'infra',
            name: 'storage-facade',
            description: 'Storage facade',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['browser/modules/mybrowser/MybrowserFacade.sys.mjs'],
          },
          {
            filename: '013-infra-storage-facade-tests.patch',
            order: 13,
            category: 'infra',
            name: 'storage-facade-tests',
            description: 'Storage facade tests',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['browser/modules/mybrowser/test/browser_mybrowser_facade_init.js'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected');
      vi.mocked(readText).mockResolvedValue('expected');

      await statusCommand(projectRoot);

      expect(getUntrackedFilesInDir).toHaveBeenCalledWith(
        '/fake/engine',
        'browser/modules/mybrowser/'
      );
      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(infoMessages()).toContain('  browser/modules/mybrowser/MybrowserFacade.sys.mjs');
      expect(infoMessages()).toContain(
        '  browser/modules/mybrowser/test/browser_mybrowser_facade_init.js'
      );
      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(infoMessages()).toContain('  browser/modules/mybrowser/unrelated.txt');
      expect(outro).toHaveBeenCalledWith('1 unmanaged, 2 patch-backed');
    });

    it('does not expand non-directory untracked entries', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/themes/shared/mybrowser-tokens.css' },
      ]);

      await statusCommand(projectRoot);

      expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
      expect(infoMessages()).toContain('  browser/themes/shared/mybrowser-tokens.css');
    });

    it('does not expand tracked modified directories', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'browser/modules/existing/' },
      ]);

      await statusCommand(projectRoot);

      expect(getUntrackedFilesInDir).not.toHaveBeenCalled();
    });
  });
});
