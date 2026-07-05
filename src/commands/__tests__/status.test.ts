// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { collectFurnaceManagedPrefixes } from '../../core/furnace-config.js';
import { getHead, getStatusWithCodes, isGitRepository } from '../../core/git.js';
import { getUntrackedFilesInDir } from '../../core/git-status.js';
import { isFileRegistered, matchesRegistrablePattern } from '../../core/manifest-rules.js';
import { computePatchedContent } from '../../core/patch-apply.js';
import { buildPatchQueueContext, collectNewFileCreatorsByPath } from '../../core/patch-lint.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { GeneralError } from '../../errors/base.js';
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

vi.mock('../../core/furnace-config.js', () => ({
  collectFurnaceManagedPrefixes: vi.fn(() => Promise.resolve(new Set())),
}));

vi.mock('../../core/git.js', () => ({
  getStatusWithCodes: vi.fn(),
  isGitRepository: vi.fn(),
  // Default: engine has a baseline commit so the unborn-HEAD early return
  // does not fire in the common test cases. The specific regression test
  // for that branch rebinds getHead to throw.
  getHead: vi.fn().mockResolvedValue('base-commit'),
  isMissingHeadError: vi.fn(
    (err: unknown) =>
      err instanceof Error &&
      /(ambiguous argument 'HEAD'|unknown revision or path not in the working tree)/i.test(
        err.message
      )
  ),
}));

vi.mock('../../core/git-status.js', () => ({
  resolveMaxUntrackedFilesPerDir: vi.fn(() => 5000),
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

vi.mock('../../core/patch-lint.js', () => ({
  buildPatchQueueContext: vi.fn(),
  collectNewFileCreatorsByPath: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  readText: vi.fn(),
  // Finding #18 added this filter pattern so status can strip atomic-
  // write temps. Export the real regex here so status's filter behaves
  // identically to production — tests for the filter rely on the same
  // exact pattern.
  FIREFORGE_TMP_PATH_PATTERN: /(^|\/)\.[^/]+\.fireforge-tmp-\d+-[0-9a-f-]{36}$/i,
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  setMachineOutputMode: vi.fn(),
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
    vi.mocked(buildPatchQueueContext).mockResolvedValue({ entries: [] });
    vi.mocked(collectNewFileCreatorsByPath).mockReturnValue(new Map());
  });

  describe('default mode (patch-aware)', () => {
    it('fails on missing fireforge.json before checking engine state', async () => {
      vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Config not found'));
      vi.mocked(pathExists).mockResolvedValue(false);

      await expect(statusCommand(projectRoot)).rejects.toThrow('Config not found');
      expect(isGitRepository).not.toHaveBeenCalled();
    });

    it('surfaces a single recovery banner when HEAD is unborn', async () => {
      // Eval regression: interrupting a `fireforge download` mid-indexing
      // leaves engine/ extracted but git has no HEAD. `fireforge status`
      // would then flood the output with hundreds of thousands of
      // untracked entries plus a truncation warning — correct but
      // unhelpful. Emit a single actionable banner pointing at
      // `fireforge download --force` instead.
      vi.mocked(getHead).mockRejectedValueOnce(
        new Error(
          "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree"
        )
      );

      await expect(statusCommand(projectRoot)).rejects.toThrow(
        /Engine repository has no baseline commit yet/
      );
      expect(getStatusWithCodes).not.toHaveBeenCalled();
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

    it('classifies unowned new branding assets as unmanaged patch candidates', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/branding/mybrowser/Assets.car' },
      ]);

      await statusCommand(projectRoot, { unmanaged: true });

      expect(infoMessages()).toContain('1 unmanaged file (1 total modified):\n');
      expect(infoMessages()).toContain('  browser/branding/mybrowser/Assets.car');
      expect(outro).toHaveBeenCalledWith('1 unmanaged change');
    });

    it('caps a pathologically large untracked directory and warns the user', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: '??', file: 'build-output/' }]);
      const HUGE = 6000;
      const files = Array.from({ length: HUGE }, (_, i) => `build-output/file_${i}.tmp`);
      vi.mocked(getUntrackedFilesInDir).mockResolvedValue(files);

      await statusCommand(projectRoot);

      // The truncation banner is the single report (the old per-directory
      // warn duplicated its content). This pins the contract that
      // truncation surfaces with the directory named, not the exact cap.
      expect(warnMessages().some((m) => m.includes('Status output is truncated'))).toBe(true);
      expect(warnMessages().some((m) => m.includes('build-output/'))).toBe(true);
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
            sourceEsrVersion: '140.9.0esr',
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
            sourceEsrVersion: '140.9.0esr',
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

    it('classifies patch-touched file as patch-owned drift when content diverges', async () => {
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
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['toolkit/foo.cpp'],
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('different actual content');

      vi.mocked(getStatusWithCodes).mockResolvedValue([{ status: 'M', file: 'toolkit/foo.cpp' }]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Patch-owned drift:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      expect(warnMessages()).not.toContain('Patch-backed materialized changes:');
      expect(infoMessages()).toContain('  toolkit/foo.cpp');
      expect(outro).toHaveBeenCalledWith('1 patch-owned drift');
    });

    it('keeps manually resolved rebase files owned rather than unmanaged', async () => {
      const files = [
        'browser/base/content/test/startup/browser.toml',
        'browser/components/extensions/parent/ext-browser.js',
        'browser/components/sessionstore/SessionStore.sys.mjs',
        'browser/modules/moz.build',
        'tools/profiler/rust-api/build.rs',
      ];
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '010-ui-rebase-refresh.patch',
            order: 10,
            category: 'ui',
            name: 'rebase-refresh',
            description: 'Manual rebase refresh',
            createdAt: '2026-06-03T00:00:00Z',
            sourceEsrVersion: '152.0b6',
            sourceProduct: 'firefox-devedition',
            sourceVersion: '152.0b6',
            filesAffected: files,
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('manual resolution content');
      vi.mocked(getStatusWithCodes).mockResolvedValue(files.map((file) => ({ status: 'M', file })));

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Patch-owned drift:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
      for (const file of files) {
        expect(infoMessages()).toContain(`  ${file}`);
      }
      expect(outro).toHaveBeenCalledWith('5 patch-owned drift');
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
            sourceEsrVersion: '140.9.0esr',
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
            sourceEsrVersion: '140.9.0esr',
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

    it('classifies deleted file as patch-owned drift when patch expects modification', async () => {
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
            sourceEsrVersion: '140.9.0esr',
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

      expect(warnMessages()).toContain('Patch-owned drift:');
      expect(warnMessages()).not.toContain('Unmanaged changes:');
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
            sourceEsrVersion: '140.9.0esr',
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

    it('classifies furnace-managed files in their own bucket', async () => {
      vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
        new Set(['toolkit/content/widgets/moz-button/'])
      );
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/content/widgets/moz-button/moz-button.css' },
        { status: 'M', file: 'toolkit/components/example.cpp' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Furnace-managed component changes:');
      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(infoMessages()).toContain('  toolkit/content/widgets/moz-button/moz-button.css');
      expect(infoMessages()).toContain('  toolkit/components/example.cpp');
      expect(outro).toHaveBeenCalledWith('1 unmanaged, 1 furnace');
    });

    it('does not classify files as furnace-managed when no furnace config exists', async () => {
      vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(new Set());
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: 'M', file: 'toolkit/content/widgets/moz-button/moz-button.css' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).not.toContain('Furnace-managed component changes:');
      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(outro).toHaveBeenCalledWith('1 unmanaged');
    });

    it('shows all four buckets when files span all categories', async () => {
      vi.mocked(collectFurnaceManagedPrefixes).mockResolvedValue(
        new Set(['toolkit/content/widgets/moz-panel/'])
      );
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
            sourceEsrVersion: '140.9.0esr',
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
        { status: 'M', file: 'toolkit/content/widgets/moz-panel/moz-panel.mjs' },
      ]);

      await statusCommand(projectRoot);

      expect(warnMessages()).toContain('Unmanaged changes:');
      expect(warnMessages()).toContain('Patch-backed materialized changes:');
      expect(warnMessages()).toContain('Tool-managed branding changes:');
      expect(warnMessages()).toContain('Furnace-managed component changes:');
      expect(outro).toHaveBeenCalledWith('1 unmanaged, 1 patch-backed, 1 branding, 1 furnace');
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
            sourceEsrVersion: '140.9.0esr',
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

    // 2026-04-24 eval Finding 2: a new engine module directory whose parent
    // `browser/modules/<binary>/moz.build` does not yet exist used to fail
    // `status --unmanaged` with exit code 1 because `isFileRegistered`
    // throws `GeneralError("Manifest not found: …")` synchronously and the
    // `Promise.all` in `printUnregisteredWarnings` re-threw it out of the
    // command. Status is a read-only reporter; it should surface the
    // missing-manifest case as a warning line and still exit cleanly so it
    // remains usable in scripted discovery workflows.
    it('tolerates a missing parent moz.build when reporting new unmanaged files', async () => {
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: 'browser/modules/freshforge/FreshQA.sys.mjs' },
      ]);
      vi.mocked(matchesRegistrablePattern).mockReturnValue(true);
      vi.mocked(isFileRegistered).mockRejectedValue(
        new GeneralError('Manifest not found: browser/modules/freshforge/moz.build')
      );

      await expect(statusCommand(projectRoot, { unmanaged: true })).resolves.toBeUndefined();

      expect(warnMessages()).toContain('Files whose registration manifest does not exist yet:');
      const missingLine = infoMessages().find((m) =>
        m.includes('browser/modules/freshforge/FreshQA.sys.mjs')
      );
      expect(missingLine).toBeDefined();
    });
  });

  describe('flag validation', () => {
    it('throws when both --raw and --unmanaged are provided', async () => {
      await expect(statusCommand(projectRoot, { raw: true, unmanaged: true })).rejects.toThrow(
        'Cannot use --raw, --unmanaged, --ownership, and --json together'
      );
    });

    it('throws when --raw and --ownership are combined', async () => {
      await expect(statusCommand(projectRoot, { raw: true, ownership: true })).rejects.toThrow(
        'Cannot use --raw, --unmanaged, --ownership, and --json together'
      );
    });

    it('throws when --unmanaged and --ownership are combined', async () => {
      await expect(
        statusCommand(projectRoot, { unmanaged: true, ownership: true })
      ).rejects.toThrow('Cannot use --raw, --unmanaged, --ownership, and --json together');
    });
  });

  describe('--ownership mode', () => {
    it('exits non-zero when two patches share a filesAffected entry', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-a.patch',
            order: 1,
            category: 'ui',
            name: 'a',
            description: '',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/content/browser.js'],
          },
          {
            filename: '002-ui-b.patch',
            order: 2,
            category: 'ui',
            name: 'b',
            description: '',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/content/browser.js'],
          },
        ],
      });
      vi.mocked(getStatusWithCodes).mockResolvedValue([]);

      await expect(statusCommand(projectRoot, { ownership: true })).rejects.toBeInstanceOf(
        GeneralError
      );
    });

    it('flags a duplicate-new-file-creation conflict that verify would catch', async () => {
      // Alignment fix regression: two patches both hit `/dev/null →
      // b/foo.js` in their bodies but only one lists the path in its
      // `filesAffected` row. Previously status --ownership walked
      // only filesAffected and reported the queue clean, while
      // verify correctly rejected it. Now status --ownership
      // consumes the same structured map verify does and agrees.
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-a.patch',
            order: 1,
            category: 'ui',
            name: 'a',
            description: '',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['foo/A.sys.mjs'],
          },
          {
            filename: '002-ui-b.patch',
            order: 2,
            category: 'ui',
            name: 'b',
            description: '',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['foo/B.sys.mjs'],
          },
        ],
      });
      vi.mocked(getStatusWithCodes).mockResolvedValue([]);
      vi.mocked(collectNewFileCreatorsByPath).mockReturnValue(
        new Map([['foo/Shared.sys.mjs', ['001-ui-a.patch', '002-ui-b.patch']]])
      );

      const err = await statusCommand(projectRoot, { ownership: true }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GeneralError);
      if (err instanceof GeneralError) {
        expect(err.message).toContain('claimed by more than one patch');
      }
      // The rendered table should name the dup-create conflict type
      // alongside the two creators so the operator sees which fix
      // applies.
      const rendered = [...infoMessages(), ...warnMessages()].join('\n');
      expect(rendered).toContain('foo/Shared.sys.mjs');
      expect(rendered).toContain('001-ui-a.patch');
      expect(rendered).toContain('002-ui-b.patch');
      expect(rendered).toContain('CONFLICT');
    });

    it('returns cleanly when the queue has no conflicts', async () => {
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-ui-a.patch',
            order: 1,
            category: 'ui',
            name: 'a',
            description: '',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['foo/A.sys.mjs'],
          },
        ],
      });
      vi.mocked(getStatusWithCodes).mockResolvedValue([]);
      vi.mocked(collectNewFileCreatorsByPath).mockReturnValue(
        new Map([['foo/A.sys.mjs', ['001-ui-a.patch']]])
      );

      await statusCommand(projectRoot, { ownership: true });

      expect(outro).toHaveBeenCalledWith('1 managed');
    });

    it('shows patch-owned drift in the ownership table for claimed modified files', async () => {
      const files = [
        'browser/base/content/test/startup/browser.toml',
        'browser/components/extensions/parent/ext-browser.js',
        'browser/components/sessionstore/SessionStore.sys.mjs',
        'browser/modules/moz.build',
        'tools/profiler/rust-api/build.rs',
      ];
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '010-ui-rebase-refresh.patch',
            order: 10,
            category: 'ui',
            name: 'rebase-refresh',
            description: '',
            createdAt: '2026-06-03T00:00:00Z',
            sourceEsrVersion: '152.0b6',
            sourceProduct: 'firefox-devedition',
            sourceVersion: '152.0b6',
            filesAffected: files,
          },
        ],
      });
      vi.mocked(computePatchedContent).mockResolvedValue('expected content');
      vi.mocked(readText).mockResolvedValue('manual resolution content');
      vi.mocked(getStatusWithCodes).mockResolvedValue(files.map((file) => ({ status: 'M', file })));

      await statusCommand(projectRoot, { ownership: true });

      const rendered = infoMessages().join('\n');
      expect(rendered).toContain('patch-owned drift');
      expect(rendered).not.toContain('| - ');
      for (const file of files) {
        expect(rendered).toContain(file);
      }
      expect(outro).toHaveBeenCalledWith('5 managed');
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
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/modules/mybrowser/MybrowserFacade.sys.mjs'],
          },
          {
            filename: '013-infra-storage-facade-tests.patch',
            order: 13,
            category: 'infra',
            name: 'storage-facade-tests',
            description: 'Storage facade tests',
            createdAt: '2025-01-01T00:00:00Z',
            sourceEsrVersion: '140.9.0esr',
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

  describe('FireForge temp-file filtering (Finding #18)', () => {
    it('omits .fireforge-tmp-<pid>-<uuid> entries from every status mode', async () => {
      // Finding #18 regression guard. `writeFileAtomic` names its
      // rename-target `.<filename>.fireforge-tmp-<pid>-<uuid>`; a
      // concurrent `status` run during a brand.ftl or mozconfig write
      // briefly saw those entries in the raw git output. The filter
      // in status.ts excises them before classification so no mode
      // leaks the temp path.
      const tempFile = '.mozconfig.fireforge-tmp-12345-11111111-2222-3333-4444-555555555555';
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: tempFile },
        { status: 'M', file: 'browser/base/content/browser.xhtml' },
      ]);

      await statusCommand(projectRoot);

      const messages = infoMessages();
      expect(messages.join('\n')).not.toContain('fireforge-tmp-');
      expect(messages).toContain('  browser/base/content/browser.xhtml');
    });

    it('preserves an operator-named file that looks similar but lacks the PID+UUID tail', async () => {
      // The pattern is anchored to `fireforge-tmp-<digits>-<uuid>` so a
      // manually-named backup like `.notes.fireforge-tmp-backup` is
      // NOT treated as a FireForge temp.
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: '??', file: '.notes.fireforge-tmp-backup' },
      ]);

      await statusCommand(projectRoot);

      expect(infoMessages()).toContain('  .notes.fireforge-tmp-backup');
    });
  });

  describe('clean-tree output shape (Finding #3)', () => {
    it('emits the documented JSON object via stdout when --json is set and the tree is clean', async () => {
      // Regression guard for the clean-tree `--json` branch. Pre-0.16.0
      // the empty-files early-return ran before the `--json` check and
      // printed "No modified files" / "Working tree clean" human text,
      // so a pipe through `jq` broke on the most common clean-workspace
      // invocation.
      vi.mocked(getStatusWithCodes).mockResolvedValue([]);
      vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });

      try {
        await statusCommand(projectRoot, { json: true });
      } finally {
        stdoutSpy.mockRestore();
      }

      const combined = writes.join('');
      const payload = JSON.parse(combined) as {
        schemaVersion: number;
        summary: { total: number };
        files: unknown[];
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.summary.total).toBe(0);
      expect(payload.files).toEqual([]);
      // Human banner must NOT fire in json mode on a clean tree.
      expect(infoMessages()).not.toContain('No modified files');
    });

    it('writes nothing to stdout when --raw is set and the tree is clean', async () => {
      // Raw consumers parse `git status --porcelain`-shaped output. A
      // clean tree produces no lines there, and `fireforge status --raw`
      // now matches that — the "No modified files" / "Working tree
      // clean" human banner previously contaminated the pipe.
      vi.mocked(getStatusWithCodes).mockResolvedValue([]);
      vi.mocked(getUntrackedFilesInDir).mockResolvedValue([]);
      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });

      try {
        await statusCommand(projectRoot, { raw: true });
      } finally {
        stdoutSpy.mockRestore();
      }

      expect(writes.join('')).toBe('');
      expect(infoMessages()).not.toContain('No modified files');
    });
  });

  describe('cross-patch ownership conflicts surface in --json (Finding #15)', () => {
    it('classifies files claimed by two patches as "conflict" with a claimedBy list', async () => {
      // Pre-0.16.0 `--json` treated conflicted files as `unmanaged`, so
      // scripts downstream of the JSON view mis-diagnosed the true
      // ownership state and took the wrong corrective action. The
      // ownership multimap now feeds the classifier so JSON and
      // `--ownership` agree on the same drift semantics.
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: ' M', file: 'browser/base/jar.mn' },
      ]);
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '002-ui-workbench-chrome-doc.patch',
            order: 2,
            category: 'ui',
            name: 'workbench-chrome-doc',
            description: '',
            createdAt: '2026-04-21T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/jar.mn'],
          },
          {
            filename: '003-ui-browser-wire-eval-hook.patch',
            order: 3,
            category: 'ui',
            name: 'browser-wire-eval-hook',
            description: '',
            createdAt: '2026-04-21T00:00:01.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/jar.mn'],
          },
        ],
      });

      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });

      try {
        await statusCommand(projectRoot, { json: true });
      } finally {
        stdoutSpy.mockRestore();
      }

      const payload = JSON.parse(writes.join('')) as {
        schemaVersion: number;
        summary: { total: number; byClassification: Record<string, number> };
        files: Array<{
          file: string;
          classification: string;
          claimedBy?: string[];
        }>;
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.summary.total).toBe(1);
      expect(payload.summary.byClassification['conflict']).toBe(1);
      expect(payload.files).toHaveLength(1);
      expect(payload.files[0]?.file).toBe('browser/base/jar.mn');
      expect(payload.files[0]?.classification).toBe('conflict');
      expect(payload.files[0]?.claimedBy).toEqual([
        '002-ui-workbench-chrome-doc.patch',
        '003-ui-browser-wire-eval-hook.patch',
      ]);
    });

    it('leaves single-owner patch-backed entries without a claimedBy field', async () => {
      // Non-conflict entries must stay byte-identical to the pre-0.16.0
      // JSON shape so parsers that do not know about the new `claimedBy`
      // field continue to work.
      vi.mocked(getStatusWithCodes).mockResolvedValue([
        { status: ' M', file: 'browser/base/foo.js' },
      ]);
      vi.mocked(loadPatchesManifest).mockResolvedValue({
        version: 1,
        patches: [
          {
            filename: '001-foo.patch',
            order: 1,
            category: 'ui',
            name: 'foo',
            description: '',
            createdAt: '2026-04-21T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/foo.js'],
          },
        ],
      });
      // Content matches expected patch content → `patch-backed`.
      vi.mocked(computePatchedContent).mockResolvedValue('ok');
      vi.mocked(readText).mockResolvedValue('ok');

      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });

      try {
        await statusCommand(projectRoot, { json: true });
      } finally {
        stdoutSpy.mockRestore();
      }

      const payload = JSON.parse(writes.join('')) as {
        schemaVersion: number;
        summary: { total: number; byClassification: Record<string, number> };
        files: Array<{
          file: string;
          classification: string;
          claimedBy?: string[];
        }>;
      };
      expect(payload.schemaVersion).toBe(1);
      expect(payload.summary.total).toBe(1);
      expect(payload.summary.byClassification['patch-backed']).toBe(1);
      expect(payload.files).toHaveLength(1);
      expect(payload.files[0]?.classification).toBe('patch-backed');
      expect(payload.files[0]).not.toHaveProperty('claimedBy');
    });
  });

  describe('--json error paths emit exactly one JSON line (Finding 1)', () => {
    it('engine-missing: stdout carries only the JSON object, never the human banner', async () => {
      // Pre-fix: emitJsonError wrote the JSON line and then threw a
      // GeneralError. withErrorHandling routed that through `logError`
      // (clack `p.log.error`), which prints the styled "■ Firefox source
      // not found …" banner to stdout. Scripts piping `status --json` to
      // jq broke on every engine-missing exit. The fix throws a
      // CommandError instead, which withErrorHandling does not log —
      // bin/fireforge.ts catches the CommandError and exits with the
      // carried code, so stdout stays a single JSON line.
      vi.mocked(pathExists).mockImplementation((path: string) => {
        // engine/ missing — every other path is irrelevant for the
        // engine-missing branch.
        if (path === '/fake/engine') return Promise.resolve(false);
        return Promise.resolve(true);
      });

      const writes: string[] = [];
      const stdoutSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation((chunk: string | Uint8Array): boolean => {
          writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
          return true;
        });

      let caught: unknown;
      try {
        await statusCommand(projectRoot, { json: true });
      } catch (err: unknown) {
        caught = err;
      } finally {
        stdoutSpy.mockRestore();
      }

      // CommandError carries the exit code without going through the
      // FireForgeError logging path.
      expect(caught).toBeDefined();
      expect((caught as { name?: string }).name).toBe('CommandError');

      const combined = writes.join('');
      const lines = combined.trim().split('\n');
      expect(lines).toHaveLength(1);
      const firstLine = lines[0] ?? '';
      const parsed = JSON.parse(firstLine) as {
        schemaVersion: number;
        error: string;
        code: string;
      };
      expect(parsed.schemaVersion).toBe(1);
      expect(parsed.code).toBe('engine-missing');
      expect(parsed.error).toMatch(/Firefox source not found/);
      // Human banner must not appear on stdout.
      expect(combined).not.toContain('■');
    });
  });
});
