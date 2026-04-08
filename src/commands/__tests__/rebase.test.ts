// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RebaseSession } from '../../core/rebase-session.js';
import type { PatchInfo } from '../../types/commands/index.js';

// ── Hoisted mocks ──

const {
  loadConfigMock,
  loadStateMock,
  saveStateMock,
  getProjectPathsMock,
  getHeadMock,
  isGitRepositoryMock,
  resetChangesMock,
  hasChangesMock,
  pathExistsMock,
  loadPatchesManifestMock,
  stampPatchVersionsMock,
  discoverPatchesMock,
  applyPatchWithFuzzMock,
  loadRebaseSessionMock,
  saveRebaseSessionMock,
  clearRebaseSessionMock,
  hasActiveRebaseSessionMock,
  getDiffForFilesAgainstHeadMock,
  getStagedDiffForFilesMock,
  stageFilesMock,
  unstageFilesMock,
  updatePatchMock,
  updatePatchMetadataMock,
  confirmMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadStateMock: vi.fn(() => Promise.resolve({})),
  saveStateMock: vi.fn(() => Promise.resolve()),
  getProjectPathsMock: vi.fn(),
  getHeadMock: vi.fn(() => Promise.resolve('abc123')),
  isGitRepositoryMock: vi.fn(() => Promise.resolve(true)),
  resetChangesMock: vi.fn(() => Promise.resolve()),
  hasChangesMock: vi.fn(() => Promise.resolve(false)),
  pathExistsMock: vi.fn(() => Promise.resolve(true)),
  loadPatchesManifestMock: vi.fn(),
  stampPatchVersionsMock: vi.fn(() => Promise.resolve()),
  discoverPatchesMock: vi.fn<(patchesDir: string) => Promise<PatchInfo[]>>(() =>
    Promise.resolve([])
  ),
  applyPatchWithFuzzMock: vi.fn(),
  loadRebaseSessionMock: vi.fn<(projectRoot: string) => Promise<RebaseSession | null>>(() =>
    Promise.resolve(null)
  ),
  saveRebaseSessionMock: vi.fn(() => Promise.resolve()),
  clearRebaseSessionMock: vi.fn(() => Promise.resolve()),
  hasActiveRebaseSessionMock: vi.fn(() => Promise.resolve(false)),
  getDiffForFilesAgainstHeadMock: vi.fn(() => Promise.resolve('')),
  getStagedDiffForFilesMock: vi.fn(() => Promise.resolve('')),
  stageFilesMock: vi.fn(() => Promise.resolve()),
  unstageFilesMock: vi.fn(() => Promise.resolve()),
  updatePatchMock: vi.fn(() => Promise.resolve()),
  updatePatchMetadataMock: vi.fn(() => Promise.resolve()),
  confirmMock: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: loadConfigMock,
  loadState: loadStateMock,
  saveState: saveStateMock,
  getProjectPaths: getProjectPathsMock,
}));

vi.mock('../../core/git.js', () => ({
  getHead: getHeadMock,
  isGitRepository: isGitRepositoryMock,
  resetChanges: resetChangesMock,
  hasChanges: hasChangesMock,
}));

vi.mock('../../core/git-diff.js', () => ({
  getDiffForFilesAgainstHead: getDiffForFilesAgainstHeadMock,
  getStagedDiffForFiles: getStagedDiffForFilesMock,
}));

vi.mock('../../core/git-file-ops.js', () => ({
  stageFiles: stageFilesMock,
  unstageFiles: unstageFilesMock,
}));

vi.mock('../../core/patch-export.js', () => ({
  updatePatch: updatePatchMock,
  updatePatchMetadata: updatePatchMetadataMock,
}));

vi.mock('../../core/patch-manifest.js', () => ({
  loadPatchesManifest: loadPatchesManifestMock,
  stampPatchVersions: stampPatchVersionsMock,
}));

vi.mock('../../core/patch-files.js', () => ({
  discoverPatches: discoverPatchesMock,
}));

vi.mock('../../core/patch-parse.js', () => ({
  extractConflictingFiles: vi.fn(() => []),
}));

vi.mock('../../core/patch-apply-fuzz.js', () => ({
  applyPatchWithFuzz: applyPatchWithFuzzMock,
}));

vi.mock('../../core/rebase-session.js', () => ({
  loadRebaseSession: loadRebaseSessionMock,
  saveRebaseSession: saveRebaseSessionMock,
  clearRebaseSession: clearRebaseSessionMock,
  hasActiveRebaseSession: hasActiveRebaseSessionMock,
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: pathExistsMock,
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn(() => false),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('@clack/prompts', () => ({
  confirm: confirmMock,
}));

import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import { NoRebaseSessionError, RebaseSessionExistsError } from '../../errors/rebase.js';
import { rebaseCommand } from '../rebase.js';

const defaultPaths = {
  root: '/project',
  engine: '/project/engine',
  patches: '/project/patches',
  fireforgeDir: '/project/.fireforge',
  config: '/project/fireforge.json',
  state: '/project/.fireforge/state.json',
  configs: '/project/configs',
  src: '/project/src',
  componentsDir: '/project/src/components',
};

function setupDefaults(): void {
  getProjectPathsMock.mockReturnValue(defaultPaths);
  loadConfigMock.mockResolvedValue({ firefox: { version: '140.0esr', product: 'firefox-esr' } });
  pathExistsMock.mockResolvedValue(true);
  isGitRepositoryMock.mockResolvedValue(true);
  getHeadMock.mockResolvedValue('abc123');
  loadStateMock.mockResolvedValue({});
}

function makeSession(patches: RebaseSession['patches']): RebaseSession {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    fromVersion: '128.0esr',
    toVersion: '140.0esr',
    preRebaseCommit: 'abc123',
    currentIndex: 0,
    patches,
  };
}

describe('fireforge rebase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('throws when engine does not exist', async () => {
    pathExistsMock.mockResolvedValue(false);
    await expect(rebaseCommand('/project')).rejects.toBeInstanceOf(GeneralError);
  });

  it('throws when session already exists', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(true);
    loadPatchesManifestMock.mockResolvedValue({ version: 1, patches: [] });
    await expect(rebaseCommand('/project')).rejects.toBeInstanceOf(RebaseSessionExistsError);
  });

  it('does nothing when all patches match current version', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['file.txt'],
        },
      ],
    });

    // Should not throw — just a no-op
    await rebaseCommand('/project');
    expect(resetChangesMock).not.toHaveBeenCalled();
  });

  it('applies all patches cleanly and completes', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['file.txt'],
        },
      ],
    });
    discoverPatchesMock.mockResolvedValue([
      { path: '/project/patches/001-branding.patch', filename: '001-branding.patch', order: 1 },
    ] as never);
    applyPatchWithFuzzMock.mockResolvedValue({ success: true, fuzzFactor: 0 });
    getDiffForFilesAgainstHeadMock.mockResolvedValue('diff --git a/file.txt b/file.txt\n');

    await rebaseCommand('/project');

    expect(resetChangesMock).toHaveBeenCalled();
    expect(applyPatchWithFuzzMock).toHaveBeenCalled();
    expect(clearRebaseSessionMock).toHaveBeenCalled();
    expect(stampPatchVersionsMock).toHaveBeenCalledWith(
      '/project/patches',
      ['001-branding.patch'],
      '140.0esr'
    );
  });

  it('dry run does not modify state', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: [],
        },
      ],
    });

    await rebaseCommand('/project', { dryRun: true });

    expect(resetChangesMock).not.toHaveBeenCalled();
    expect(saveRebaseSessionMock).not.toHaveBeenCalled();
  });
});

describe('fireforge rebase --abort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('throws when no session exists', async () => {
    loadRebaseSessionMock.mockResolvedValue(null);
    await expect(rebaseCommand('/project', { abort: true })).rejects.toBeInstanceOf(
      NoRebaseSessionError
    );
  });

  it('resets engine and clears session', async () => {
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    } as never);

    await rebaseCommand('/project', { abort: true });
    expect(resetChangesMock).toHaveBeenCalled();
    expect(clearRebaseSessionMock).toHaveBeenCalled();
  });

  it('requires confirmation when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    confirmMock.mockResolvedValue(false);
    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = true as never;
    process.stdout.isTTY = true as never;
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    } as never);

    try {
      await rebaseCommand('/project', { abort: true });
      expect(confirmMock).toHaveBeenCalled();
      expect(resetChangesMock).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = origStdin as never;
      process.stdout.isTTY = origStdout as never;
    }
  });

  it('skips confirmation with --force when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    } as never);

    await rebaseCommand('/project', { abort: true, force: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resetChangesMock).toHaveBeenCalled();
  });

  it('throws in non-interactive mode without --force when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = undefined as never;
    process.stdout.isTTY = undefined as never;

    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    } as never);

    try {
      await expect(rebaseCommand('/project', { abort: true })).rejects.toBeInstanceOf(
        InvalidArgumentError
      );
    } finally {
      process.stdin.isTTY = origStdin as never;
      process.stdout.isTTY = origStdout as never;
    }
  });
});

describe('fireforge rebase — dirty-tree guard on fresh start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaults();
  });

  it('prompts confirmation when engine has uncommitted changes', async () => {
    hasChangesMock.mockResolvedValue(true);
    confirmMock.mockResolvedValue(false);
    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = true as never;
    process.stdout.isTTY = true as never;
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['file.txt'],
        },
      ],
    });

    try {
      await rebaseCommand('/project');
      expect(confirmMock).toHaveBeenCalled();
      expect(resetChangesMock).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = origStdin as never;
      process.stdout.isTTY = origStdout as never;
    }
  });

  it('proceeds without confirmation when --force is specified', async () => {
    hasChangesMock.mockResolvedValue(true);
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['file.txt'],
        },
      ],
    });
    discoverPatchesMock.mockResolvedValue([
      { path: '/project/patches/001-branding.patch', filename: '001-branding.patch', order: 1 },
    ] as never);
    applyPatchWithFuzzMock.mockResolvedValue({ success: true, fuzzFactor: 0 });
    getDiffForFilesAgainstHeadMock.mockResolvedValue('diff --git a/file.txt b/file.txt\n');

    await rebaseCommand('/project', { force: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resetChangesMock).toHaveBeenCalled();
  });

  it('throws in non-interactive mode with dirty engine and no --force', async () => {
    hasChangesMock.mockResolvedValue(true);
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['file.txt'],
        },
      ],
    });

    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = undefined as never;
    process.stdout.isTTY = undefined as never;

    try {
      await expect(rebaseCommand('/project')).rejects.toBeInstanceOf(InvalidArgumentError);
    } finally {
      process.stdin.isTTY = origStdin as never;
      process.stdout.isTTY = origStdout as never;
    }
  });

  it('throws when continuing without a rebase session', async () => {
    loadRebaseSessionMock.mockResolvedValue(null);

    await expect(rebaseCommand('/project', { continue: true })).rejects.toBeInstanceOf(
      NoRebaseSessionError
    );
  });

  it('throws when continuing with a corrupt session whose current patch is not failed', async () => {
    loadRebaseSessionMock.mockResolvedValue(
      makeSession([{ filename: '001-branding.patch', status: 'applied-clean' }])
    );

    await expect(rebaseCommand('/project', { continue: true })).rejects.toThrow(
      'Expected the current patch to be in a failed state'
    );
  });

  it('throws when continuing without a patches manifest entry for the failed patch', async () => {
    loadRebaseSessionMock.mockResolvedValue(
      makeSession([{ filename: '001-branding.patch', status: 'failed' }])
    );
    loadPatchesManifestMock.mockResolvedValue(null);

    await expect(rebaseCommand('/project', { continue: true })).rejects.toBeInstanceOf(
      GeneralError
    );
  });

  it('warns and returns early when continuing generates no staged diff', async () => {
    loadRebaseSessionMock.mockResolvedValue(
      makeSession([{ filename: '001-branding.patch', status: 'failed' }])
    );
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['browser/file.txt'],
        },
      ],
    });
    getStagedDiffForFilesMock.mockResolvedValue('   ');

    await rebaseCommand('/project', { continue: true });

    expect(stageFilesMock).toHaveBeenCalledWith('/project/engine', ['browser/file.txt']);
    expect(unstageFilesMock).toHaveBeenCalledWith('/project/engine', ['browser/file.txt']);
    expect(updatePatchMock).not.toHaveBeenCalled();
    expect(updatePatchMetadataMock).not.toHaveBeenCalled();
    expect(saveRebaseSessionMock).not.toHaveBeenCalled();
  });

  it('continues after resolving a patch, clears pending resolution, and completes the rebase', async () => {
    loadRebaseSessionMock.mockResolvedValue(
      makeSession([
        { filename: '001-branding.patch', status: 'failed' },
        { filename: '002-ui.patch', status: 'pending' },
      ])
    );
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['browser/file.txt'],
        },
        {
          filename: '002-ui.patch',
          order: 2,
          category: 'ui',
          name: 'ui',
          description: 'test',
          createdAt: '2025-01-02',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['browser/ui.js'],
        },
      ],
    });
    getStagedDiffForFilesMock.mockResolvedValue(
      'diff --git a/browser/file.txt b/browser/file.txt\n'
    );
    discoverPatchesMock.mockResolvedValue([
      { filename: '002-ui.patch', path: '/project/patches/002-ui.patch', order: 2 },
    ]);
    applyPatchWithFuzzMock.mockResolvedValue({ success: true, fuzzFactor: 1 });
    getDiffForFilesAgainstHeadMock.mockResolvedValue(
      'diff --git a/browser/ui.js b/browser/ui.js\n'
    );
    loadStateMock
      .mockResolvedValueOnce({
        pendingResolution: {
          patchFilename: '001-branding.patch',
          originalError: 'patch failed',
        },
      })
      .mockResolvedValueOnce({});

    await rebaseCommand('/project', { continue: true });

    expect(updatePatchMock).toHaveBeenCalledWith(
      '/project/patches/001-branding.patch',
      'diff --git a/browser/file.txt b/browser/file.txt\n'
    );
    expect(updatePatchMetadataMock).toHaveBeenCalledWith('/project/patches', '001-branding.patch', {
      sourceEsrVersion: '140.0esr',
    });
    expect(applyPatchWithFuzzMock).toHaveBeenCalledWith(
      '/project/patches/002-ui.patch',
      '/project/engine',
      3
    );
    expect(saveStateMock).toHaveBeenCalledWith('/project', {});
    expect(stampPatchVersionsMock).toHaveBeenCalledWith(
      '/project/patches',
      ['001-branding.patch', '002-ui.patch'],
      '140.0esr'
    );
    expect(clearRebaseSessionMock).toHaveBeenCalled();
  });

  it('records a new pending resolution when the next patch fails after continue', async () => {
    loadRebaseSessionMock.mockResolvedValue(
      makeSession([
        { filename: '001-branding.patch', status: 'failed' },
        { filename: '002-ui.patch', status: 'pending' },
      ])
    );
    loadPatchesManifestMock.mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: '001-branding.patch',
          order: 1,
          category: 'branding',
          name: 'branding',
          description: 'test',
          createdAt: '2025-01-01',
          sourceEsrVersion: '128.0esr',
          filesAffected: ['browser/file.txt'],
        },
      ],
    });
    getStagedDiffForFilesMock.mockResolvedValue(
      'diff --git a/browser/file.txt b/browser/file.txt\n'
    );
    discoverPatchesMock.mockResolvedValue([
      { filename: '002-ui.patch', path: '/project/patches/002-ui.patch', order: 2 },
    ]);
    applyPatchWithFuzzMock.mockResolvedValue({
      success: false,
      error: 'patch failed again',
      rejectFiles: ['browser/ui.js.rej'],
    });
    loadStateMock
      .mockResolvedValueOnce({
        pendingResolution: {
          patchFilename: '001-branding.patch',
          originalError: 'patch failed',
        },
      })
      .mockResolvedValueOnce({});

    await rebaseCommand('/project', { continue: true });

    expect(saveStateMock).toHaveBeenNthCalledWith(1, '/project', {});
    expect(saveStateMock).toHaveBeenNthCalledWith(2, '/project', {
      pendingResolution: {
        patchFilename: '002-ui.patch',
        originalError: 'patch failed again',
      },
    });
    expect(stampPatchVersionsMock).not.toHaveBeenCalled();
    expect(clearRebaseSessionMock).not.toHaveBeenCalled();
  });
});
