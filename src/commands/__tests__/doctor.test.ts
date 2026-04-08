// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  configExists: vi.fn(() => Promise.resolve(true)),
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    })
  ),
  loadState: vi.fn(() => Promise.resolve({})),
  getProjectPaths: vi.fn(() => ({
    root: '/project',
    engine: '/project/engine',
    config: '/project/fireforge.json',
    fireforgeDir: '/project/.fireforge',
    state: '/project/.fireforge/state.json',
    patches: '/project/patches',
    configs: '/project/configs',
    src: '/project/src',
    componentsDir: '/project/components',
  })),
}));

vi.mock('../../core/git-base.js', () => ({
  ensureGit: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/git.js')>();
  return {
    isGitRepository: vi.fn(() => Promise.resolve(true)),
    getHead: vi.fn(() => Promise.resolve('base-commit')),
    getCurrentBranch: vi.fn(() => Promise.resolve('firefox')),
    isMissingHeadError: actual.isMissingHeadError,
  };
});

vi.mock('../../core/git-status.js', () => ({
  getWorkingTreeStatus: vi.fn(() => Promise.resolve([])),
  expandUntrackedDirectoryEntries: vi.fn((_dir: string, entries: unknown[]) =>
    Promise.resolve(entries)
  ),
}));

vi.mock('../../core/mach.js', () => ({
  ensurePython: vi.fn(() => Promise.resolve()),
  ensureMach: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/patch-apply.js', () => ({
  countPatches: vi.fn(() => Promise.resolve(1)),
}));

vi.mock('../../core/patch-manifest.js', () => ({
  rebuildPatchesManifest: vi.fn(() => Promise.resolve({ version: 1, patches: [] })),
  validatePatchIntegrity: vi.fn(() => Promise.resolve([])),
  validatePatchesManifestConsistency: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));

import { configExists, loadConfig, loadState } from '../../core/config.js';
import { getCurrentBranch, getHead, isGitRepository } from '../../core/git.js';
import { ensureGit } from '../../core/git-base.js';
import { getWorkingTreeStatus } from '../../core/git-status.js';
import { ensurePython } from '../../core/mach.js';
import {
  rebuildPatchesManifest,
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../../core/patch-manifest.js';
import { pathExists } from '../../utils/fs.js';
import { error, outro, warn } from '../../utils/logger.js';
import { doctorCommand, registerDoctor } from '../doctor.js';

function createProgram(): Command {
  const program = new Command();

  registerDoctor(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

describe('doctorCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    });
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(getCurrentBranch).mockResolvedValue('firefox');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(validatePatchIntegrity).mockResolvedValue([]);
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValue({ version: 1, patches: [] });
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('reports a clean workspace as fully passing', async () => {
    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('All 14 checks passed!');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces warning-only runs without failing the exit code', async () => {
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/moz.configure',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('13 passed, 1 warning');
    expect(result.exitCode).toBe(0);
  });

  it('degrades the summary and exit code for drifted and dirty engine state', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('moved-head');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/moz.configure',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) => message.includes('Engine working tree has 1 local change'))
    ).toBe(true);
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('Engine state consistency'))
    ).toBe(true);
    expect(outro).toHaveBeenCalledWith('13 passed, 1 warning, 1 failed');
    expect(result.exitCode).toBe(1);
  });

  it('treats a detached HEAD at the recorded base commit as a warning, not a failure', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('baseline');
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('Engine is detached at the recorded base commit')
        )
    ).toBe(true);
    expect(outro).toHaveBeenCalledWith('14 passed, 1 warning');
    expect(result.exitCode).toBe(0);
  });

  it('surfaces an unborn HEAD as an incomplete download instead of a raw git error', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockRejectedValue(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) =>
          message.includes('Engine repository has no baseline commit yet')
        )
    ).toBe(true);
    expect(
      vi
        .mocked(warn)
        .mock.calls.some(([message]) =>
          message.includes('Skipped branch validation because the baseline commit is missing')
        )
    ).toBe(true);
    expect(
      vi
        .mocked(outro)
        .mock.calls.some(([message]) => typeof message === 'string' && message.includes('1 failed'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when fireforge.json is missing', async () => {
    vi.mocked(configExists).mockResolvedValueOnce(false);
    vi.mocked(loadConfig).mockRejectedValueOnce(new Error('Config not found'));

    const result = await doctorCommand('/project');

    // Check 3 "fireforge.json exists" should fail
    expect(
      vi
        .mocked(error)
        .mock.calls.some(
          ([message]) => message.includes('fireforge.json') || message.includes('not found')
        )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when engine directory is missing', async () => {
    const originalPathExists = vi.mocked(pathExists).getMockImplementation();
    vi.mocked(pathExists).mockImplementation((p: string) => Promise.resolve(!p.includes('engine')));

    const result = await doctorCommand('/project');

    // Restore original to avoid leaking
    if (originalPathExists) {
      vi.mocked(pathExists).mockImplementation(originalPathExists);
    }

    // The summary should have at least 1 failed check
    expect(result.exitCode).toBe(1);
  });

  it('reports pending resolution state as a failure', async () => {
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: {
        patchFilename: '007-ui.patch',
        originalError: 'patch failed',
      },
    });

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) =>
          message.includes('You are currently resolving a conflict for patch 007-ui.patch.')
        )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when git is not installed', async () => {
    vi.mocked(ensureGit).mockRejectedValueOnce(new Error('git not found'));

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('git') || message.includes('Git'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('fails early when engine exists but is not a git repository', async () => {
    vi.mocked(isGitRepository).mockResolvedValueOnce(false);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('engine/ is not a git repository'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports failure when Python is not found', async () => {
    vi.mocked(ensurePython).mockRejectedValueOnce(new Error('python not found'));

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('Python') || message.includes('python'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports patch integrity issues as failures', async () => {
    vi.mocked(validatePatchIntegrity).mockResolvedValueOnce([
      {
        filename: '001-ui-toolbar.patch',
        message: 'File not in source',
        targetFile: 'browser/toolbar.js',
      },
    ]);

    const result = await doctorCommand('/project');

    // The `runCheck` for Patch integrity throws when issues are found, so it becomes
    // a failed check. The error call format is: "✗ Patch integrity: ..."
    const allErrorMessages = vi.mocked(error).mock.calls.map(([msg]) => msg);
    expect(
      allErrorMessages.some(
        (message) => message.includes('Patch integrity') || message.includes('patch')
      )
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('reports patch manifest consistency issues as failures', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'untracked-patch-file',
        filename: '001-ui-toolbar.patch',
        message: '001-ui-toolbar.patch exists on disk but is not tracked in patches.json.',
      },
    ]);

    const result = await doctorCommand('/project');

    expect(
      vi
        .mocked(error)
        .mock.calls.some(([message]) => message.includes('Patch manifest consistency'))
    ).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  it('can rebuild patches.json during doctor when repair is requested', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValueOnce({
      version: 1,
      patches: [
        {
          filename: '001-ui-toolbar.patch',
          order: 1,
          category: 'ui',
          name: 'toolbar',
          description: 'Recovered',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/toolbar.js'],
        },
      ],
    });

    const result = await doctorCommand('/project', { repairPatchesManifest: true });

    expect(rebuildPatchesManifest).toHaveBeenCalledWith('/project/patches', '140.0esr');
    expect(result.exitCode).toBe(0);
    expect(
      vi.mocked(warn).mock.calls.some(([message]) => message.includes('Patch manifest consistency'))
    ).toBe(true);
  });

  it('reports a failed repair when rebuilding patches.json throws', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValueOnce([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'patches.json is missing while 1 patch file exists.',
      },
    ]);
    vi.mocked(rebuildPatchesManifest).mockRejectedValueOnce(new Error('rebuild failed'));

    const result = await doctorCommand('/project', { repairPatchesManifest: true });

    expect(result.exitCode).toBe(1);
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('rebuild failed'))
    ).toBe(true);
    expect(
      vi
        .mocked(outro)
        .mock.calls.some(([message]) => typeof message === 'string' && message.includes('1 failed'))
    ).toBe(true);
  });

  it('does not add engine state consistency check when baseCommit is missing', async () => {
    // Ensure loadState returns empty (no baseCommit), overriding any prior test leakage
    vi.mocked(loadState).mockResolvedValueOnce({});

    await doctorCommand('/project');

    // Without baseCommit, "Engine state consistency" check is never added. No state-related error.
    expect(
      vi.mocked(error).mock.calls.some(([message]) => message.includes('Engine state consistency'))
    ).toBe(false);
  });

  it('pluralizes warning summaries when multiple warning checks are present', async () => {
    vi.mocked(loadState).mockResolvedValue({ baseCommit: 'baseline' });
    vi.mocked(getHead).mockResolvedValue('baseline');
    vi.mocked(getCurrentBranch).mockResolvedValue('HEAD');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([
      {
        status: ' M',
        indexStatus: ' ',
        worktreeStatus: 'M',
        file: 'browser/components/file.js',
        isUntracked: false,
        isRenameOrCopy: false,
        isDeleted: false,
      },
    ]);

    const result = await doctorCommand('/project');

    expect(outro).toHaveBeenCalledWith('13 passed, 2 warnings');
    expect(result.exitCode).toBe(0);
  });
});

describe('registerDoctor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.exitCode = undefined;
    vi.mocked(configExists).mockResolvedValue(true);
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      license: 'EUPL-1.2',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    });
    vi.mocked(loadState).mockResolvedValue({});
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(getCurrentBranch).mockResolvedValue('firefox');
    vi.mocked(getWorkingTreeStatus).mockResolvedValue([]);
    vi.mocked(validatePatchIntegrity).mockResolvedValue([]);
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([]);
    vi.mocked(rebuildPatchesManifest).mockResolvedValue({ version: 1, patches: [] });
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  it('routes parsed CLI options through the registered action', async () => {
    vi.mocked(validatePatchesManifestConsistency).mockResolvedValue([
      {
        code: 'manifest-missing',
        filename: 'patches.json',
        message: 'manifest drift',
      },
    ]);

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'doctor', '--repair-patches-manifest']);

    expect(rebuildPatchesManifest).toHaveBeenCalledWith('/project/patches', '140.0esr');
    expect(process.exitCode).toBeUndefined();
  });

  it('sets process.exitCode when the registered action reports a failure', async () => {
    vi.mocked(configExists).mockResolvedValue(false);

    const program = createProgram();
    await program.parseAsync(['node', 'test', 'doctor']);

    expect(process.exitCode).toBe(1);
  });
});
