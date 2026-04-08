// SPDX-License-Identifier: EUPL-1.2
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
  loadState: vi.fn(),
  saveState: vi.fn(),
}));

vi.mock('../../core/git.js', () => ({
  getHead: vi.fn(),
}));

vi.mock('../../core/git-status.js', () => ({
  getDirtyFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../core/patch-apply.js', () => ({
  countPatches: vi.fn(),
  discoverPatches: vi.fn().mockResolvedValue([]),
  extractAffectedFiles: vi.fn().mockReturnValue([]),
  applyPatchesWithContinue: vi.fn(),
  computePatchedContent: vi.fn().mockResolvedValue(''),
  PatchError: class PatchError extends Error {},
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: vi.fn(),
  checkVersionCompatibility: vi.fn().mockReturnValue(null),
  validatePatchIntegrity: vi.fn().mockResolvedValue([]),
  validatePatchesManifestConsistency: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn().mockResolvedValue(true),
  readText: vi.fn().mockResolvedValue(''),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    stop: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@clack/prompts', () => ({
  confirm: vi.fn(),
}));

import { confirm } from '@clack/prompts';

import { loadState, saveState } from '../../core/config.js';
import { getHead } from '../../core/git.js';
import { getDirtyFiles } from '../../core/git-status.js';
import {
  applyPatchesWithContinue,
  computePatchedContent,
  countPatches,
  discoverPatches,
  extractAffectedFiles,
} from '../../core/patch-apply.js';
import {
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../../core/patch-manifest.js';
import { pathExists, readText } from '../../utils/fs.js';
import { error, info, outro, spinner, success, warn } from '../../utils/logger.js';
import { importCommand } from '../import.js';

function setStdinIsTTY(value: boolean): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');

  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value,
  });

  return () => {
    if (descriptor) {
      Object.defineProperty(process.stdin, 'isTTY', descriptor);
    }
  };
}

describe('importCommand drift handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'base-commit' });
    vi.mocked(getHead).mockResolvedValue('drifted-head');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(getDirtyFiles).mockResolvedValue([]);
    vi.mocked(computePatchedContent).mockResolvedValue('');
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(readText).mockResolvedValue('');
    vi.mocked(applyPatchesWithContinue).mockResolvedValue({
      total: 1,
      succeeded: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: true,
        },
      ],
      failed: [],
      skipped: [],
    });
  });

  it('cancels in non-interactive mode without --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await expect(importCommand('/fake/root')).rejects.toThrow(
        'Engine HEAD has drifted from base commit. Re-run with --force to bypass drift check.'
      );
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('still cancels in non-interactive mode with --continue but without --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await expect(importCommand('/fake/root', { continue: true })).rejects.toThrow(
        'Engine HEAD has drifted from base commit. Re-run with --force to bypass drift check.'
      );
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('proceeds in non-interactive mode with --force', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await importCommand('/fake/root', { force: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', false);
    expect(warn).toHaveBeenCalledWith(
      'Engine HEAD has drifted from base commit. Continuing because --force was provided in non-interactive mode.'
    );
  });

  it('proceeds in non-interactive mode with both --force and --continue', async () => {
    const restoreTTY = setStdinIsTTY(false);

    try {
      await importCommand('/fake/root', { force: true, continue: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', true);
  });

  it('still prompts in interactive mode when drift is detected', async () => {
    const restoreTTY = setStdinIsTTY(true);
    vi.mocked(confirm).mockResolvedValue(false);

    try {
      await importCommand('/fake/root');
    } finally {
      restoreTTY();
    }

    expect(confirm).toHaveBeenCalled();
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
    expect(outro).toHaveBeenCalledWith('Import cancelled by user');
  });

  it('skips prompt in interactive mode with --force when drift is detected', async () => {
    const restoreTTY = setStdinIsTTY(true);

    try {
      await importCommand('/fake/root', { force: true });
    } finally {
      restoreTTY();
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', false);
    expect(warn).toHaveBeenCalledWith(
      'Engine HEAD has drifted from base commit. Continuing because --force was provided.'
    );
  });

  it('allows already materialized patch-backed files without requiring --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(getDirtyFiles).mockResolvedValue(['browser/modules/mybrowser/FlushManager.sys.mjs']);
    vi.mocked(computePatchedContent).mockResolvedValue('patched-content\n');
    vi.mocked(readText).mockResolvedValue('patched-content\n');
    vi.mocked(pathExists).mockResolvedValue(true);

    await importCommand('/fake/root');

    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', false);
    expect(info).toHaveBeenCalledWith(
      'Patch-backed materialized files already match the stored patch stack.'
    );
  });

  it('still blocks unmanaged dirty files without --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(1);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
    ]);
    vi.mocked(extractAffectedFiles).mockReturnValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
    ]);
    vi.mocked(getDirtyFiles).mockResolvedValue(['browser/modules/mybrowser/FlushManager.sys.mjs']);
    vi.mocked(computePatchedContent).mockResolvedValue('patched-content\n');
    vi.mocked(readText).mockResolvedValue('patched-content\n// local drift\n');
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(importCommand('/fake/root')).rejects.toThrow(
      'Uncommitted changes in patch-touched files. Commit or stash them first, or use --force.'
    );

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('  browser/modules/mybrowser/FlushManager.sys.mjs');
  });

  it('summarizes unmanaged dirty files before overwriting them with --force', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(countPatches).mockResolvedValue(2);
    vi.mocked(discoverPatches).mockResolvedValue([
      { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
      { filename: '002-ui-sidebar.patch', path: '/fake/patches/002.patch', order: 2 },
    ]);
    vi.mocked(extractAffectedFiles)
      .mockReturnValueOnce(['browser/modules/mybrowser/FlushManager.sys.mjs'])
      .mockReturnValueOnce(['browser/components/sidebar/sidebar.css']);
    vi.mocked(getDirtyFiles).mockResolvedValue([
      'browser/modules/mybrowser/FlushManager.sys.mjs',
      'browser/components/sidebar/sidebar.css',
    ]);
    vi.mocked(computePatchedContent)
      .mockResolvedValueOnce('patched-content\n')
      .mockResolvedValueOnce(':root { color: blue; }\n');
    vi.mocked(readText).mockImplementation((targetPath) => {
      if (targetPath === '/fake/engine/browser/modules/mybrowser/FlushManager.sys.mjs') {
        return Promise.resolve('patched-content\n// local drift\n');
      }
      if (targetPath === '/fake/engine/browser/components/sidebar/sidebar.css') {
        return Promise.resolve(':root { color: red; }\n');
      }
      return Promise.resolve('');
    });
    vi.mocked(pathExists).mockResolvedValue(true);

    await expect(importCommand('/fake/root', { force: true })).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      '--force will overwrite 2 unmanaged changes in patch-touched files:'
    );
    expect(warn).toHaveBeenCalledWith('  browser/components/sidebar/sidebar.css');
    expect(warn).toHaveBeenCalledWith('  browser/modules/mybrowser/FlushManager.sys.mjs');
    expect(warn).toHaveBeenCalledWith(
      'Patch reapplication may restore these paths to the engine baseline before reapplying patches.'
    );
  });

  it('refuses to import when patches.json disagrees with on-disk patch files', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'untracked-patch-file',
        filename: '001-ui-test.patch',
        message: '001-ui-test.patch exists on disk but is not tracked in patches.json.',
      },
    ]);

    await expect(importCommand('/fake/root', { force: true })).rejects.toThrow(
      'Patch manifest consistency check failed'
    );

    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('returns early when the patches directory does not exist', async () => {
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(targetPath !== '/fake/patches')
    );

    await expect(importCommand('/fake/root')).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith('No patches directory found. Nothing to import.');
    expect(outro).toHaveBeenCalledWith('Import complete (no patches)');
    expect(applyPatchesWithContinue).not.toHaveBeenCalled();
  });

  it('warns about patch integrity issues but still applies the patch stack', async () => {
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(validatePatchIntegrity).mockResolvedValueOnce([
      {
        filename: '001-ui-test.patch',
        message: 'references a file that is no longer present in HEAD',
        targetFile: null,
      },
    ]);

    await expect(importCommand('/fake/root')).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith('\nPatch integrity issues detected:');
    expect(warn).toHaveBeenCalledWith(
      '  001-ui-test.patch: references a file that is no longer present in HEAD'
    );
    expect(applyPatchesWithContinue).toHaveBeenCalledWith('/fake/patches', '/fake/engine', false);
  });

  it('reports auto-resolved patches and successful import summaries', async () => {
    const spinnerHandle = {
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(spinner).mockReturnValue(spinnerHandle);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockResolvedValueOnce({
      total: 2,
      succeeded: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: true,
          autoResolved: true,
        },
        {
          patch: { filename: '002-ui-followup.patch', path: '/fake/patches/002.patch', order: 2 },
          success: true,
        },
      ],
      failed: [],
      skipped: [],
    });

    await expect(importCommand('/fake/root')).resolves.toBeUndefined();

    expect(spinnerHandle.stop).toHaveBeenCalledWith('Applied 2 patches (1 auto-resolved)');
    expect(success).toHaveBeenCalledWith('  001-ui-test.patch (auto-resolved)');
    expect(success).toHaveBeenCalledWith('  002-ui-followup.patch');
    expect(outro).toHaveBeenCalledWith('All patches applied successfully!');
  });

  it('shows a generic spinner error when patch application throws a non-PatchError', async () => {
    const spinnerHandle = {
      message: vi.fn(),
      stop: vi.fn(),
      error: vi.fn(),
    };
    vi.mocked(spinner).mockReturnValue(spinnerHandle);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockRejectedValueOnce(new Error('git blew up'));

    await expect(importCommand('/fake/root')).rejects.toThrow('git blew up');

    expect(spinnerHandle.error).toHaveBeenCalledWith('Patch application failed');
    expect(spinnerHandle.stop).not.toHaveBeenCalled();
  });

  it('persists pending resolution state when patch application fails', async () => {
    const state = { baseCommit: 'base-commit' };
    vi.mocked(loadState).mockResolvedValue(state);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(applyPatchesWithContinue).mockResolvedValueOnce({
      total: 2,
      succeeded: [],
      failed: [
        {
          patch: { filename: '001-ui-test.patch', path: '/fake/patches/001.patch', order: 1 },
          success: false,
          error: 'context mismatch',
          conflictingFiles: ['browser/modules/mybrowser/FlushManager.sys.mjs'],
        },
      ],
      skipped: [{ filename: '002-ui-followup.patch', path: '/fake/patches/002.patch', order: 2 }],
    });

    await expect(importCommand('/fake/root')).rejects.toThrow('Failed to apply 1 patch(es)');

    expect(saveState).toHaveBeenCalledWith('/fake/root', {
      baseCommit: 'base-commit',
      pendingResolution: {
        patchFilename: '001-ui-test.patch',
        originalError: 'context mismatch',
      },
    });
    expect(error).toHaveBeenCalledWith('\nFailed: 001-ui-test.patch');
    expect(warn).toHaveBeenCalledWith('\n1 patch(es) were skipped:');
    expect(info).toHaveBeenCalledWith('\nResolution Instructions:');
  });
});
