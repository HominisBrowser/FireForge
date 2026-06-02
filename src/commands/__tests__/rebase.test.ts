// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RebaseSession } from '../../core/rebase-session.js';
import type { PatchInfo } from '../../types/commands/index.js';

// ── Hoisted mocks ──

const {
  loadConfigMock,
  loadStateMock,
  saveStateMock,
  updateStateMock,
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
  updatePatchAndMetadataMock,
  confirmMock,
  getFurnacePathsMock,
  updateFurnaceStateMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(),
  loadStateMock: vi.fn(() => Promise.resolve({})),
  saveStateMock: vi.fn(() => Promise.resolve()),
  updateStateMock: vi.fn<
    (
      root: string,
      updates:
        | Record<string, unknown>
        | ((current: Record<string, unknown>) => Record<string, unknown>)
    ) => Promise<void>
  >(() => Promise.resolve()),
  getProjectPathsMock: vi.fn(),
  getHeadMock: vi.fn(() => Promise.resolve('abc123')),
  isGitRepositoryMock: vi.fn(() => Promise.resolve(true)),
  resetChangesMock: vi.fn(() => Promise.resolve()),
  hasChangesMock: vi.fn(() => Promise.resolve(false)),
  pathExistsMock: vi.fn<(path: string) => Promise<boolean>>(() => Promise.resolve(true)),
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
  updatePatchAndMetadataMock: vi.fn(() => Promise.resolve()),
  confirmMock: vi.fn(() => Promise.resolve(true)),
  getFurnacePathsMock: vi.fn((root: string) => ({
    furnaceConfig: `${root}/furnace.json`,
    componentsDir: `${root}/components`,
    overridesDir: `${root}/components/overrides`,
    customDir: `${root}/components/custom`,
    furnaceState: `${root}/.fireforge/furnace-state.json`,
  })),
  updateFurnaceStateMock: vi.fn<
    (
      root: string,
      updater: (current: Record<string, unknown>) => Record<string, unknown>
    ) => Promise<void>
  >(() => Promise.resolve()),
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: loadConfigMock,
  loadState: loadStateMock,
  saveState: saveStateMock,
  updateState: updateStateMock,
  getProjectPaths: getProjectPathsMock,
}));

vi.mock('../../core/furnace-config.js', () => ({
  getFurnacePaths: getFurnacePathsMock,
  updateFurnaceState: updateFurnaceStateMock,
}));

vi.mock('../../core/git.js', () => ({
  getHead: getHeadMock,
  isGitRepository: isGitRepositoryMock,
  resetChanges: resetChangesMock,
  hasChanges: hasChangesMock,
  isMissingHeadError: (err: unknown) =>
    err instanceof Error &&
    /(ambiguous argument 'HEAD'|unknown revision or path not in the working tree)/i.test(
      err.message
    ),
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
  updatePatchAndMetadata: updatePatchAndMetadataMock,
}));

vi.mock('../../core/patch-lock.js', () => ({
  withPatchDirectoryLock: vi.fn(
    <T>(_patchesDir: string, operation: () => Promise<T>): Promise<T> => operation()
  ),
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

vi.mock('../../core/signal-critical.js', () => ({
  runInSignalCriticalSection: vi.fn(
    async <T>(_label: string, fn: () => Promise<T>): Promise<T> => fn()
  ),
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
  loadConfigMock.mockResolvedValue({ firefox: { version: '140.9.0esr', product: 'firefox-esr' } });
  pathExistsMock.mockResolvedValue(true);
  isGitRepositoryMock.mockResolvedValue(true);
  hasChangesMock.mockResolvedValue(false);
  getHeadMock.mockResolvedValue('abc123');
  loadStateMock.mockResolvedValue({});
}

function makeSession(patches: RebaseSession['patches']): RebaseSession {
  return {
    startedAt: '2026-01-01T00:00:00.000Z',
    fromVersion: '128.0esr',
    toVersion: '140.9.0esr',
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
          sourceEsrVersion: '140.9.0esr',
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
      '140.9.0esr',
      'firefox-esr'
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

  // 2026-04-24 eval Finding 11: after an aborted `download --force`, the
  // engine's `.git/` exists but has no valid HEAD. `rebase --dry-run` used
  // to print "Dry run complete" suggesting the rebase was ready to run,
  // then the real `rebase --yes` failed immediately with
  // `fatal: ambiguous argument 'HEAD'`. Dry-run now mirrors the real-run
  // baseline check and refuses with a clear recovery pointer.
  it('dry-run refuses when engine HEAD is unborn (post-aborted-download baseline)', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    getHeadMock.mockRejectedValueOnce(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );

    await expect(rebaseCommand('/project', { dryRun: true })).rejects.toThrow(
      /Engine repository has no baseline commit yet/i
    );
    expect(loadPatchesManifestMock).not.toHaveBeenCalled();
    expect(resetChangesMock).not.toHaveBeenCalled();
    expect(saveRebaseSessionMock).not.toHaveBeenCalled();
  });

  it('non-dry-run also refuses with the same message when HEAD is unborn', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    getHeadMock.mockRejectedValueOnce(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );

    await expect(rebaseCommand('/project', { yes: true })).rejects.toThrow(
      /Engine repository has no baseline commit yet/i
    );
    expect(resetChangesMock).not.toHaveBeenCalled();
    expect(saveRebaseSessionMock).not.toHaveBeenCalled();
  });

  it('clears furnace state after engine reset on fresh start', async () => {
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

    expect(updateFurnaceStateMock).toHaveBeenCalledTimes(1);
    const call = updateFurnaceStateMock.mock.calls[0];
    expect(call).toBeDefined();
    const updater = call?.[1];
    expect(typeof updater).toBe('function');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(updater!({ appliedChecksums: { 'override/x/x.css': 'abc' } })).toEqual({});
  });

  it('preserves pendingRepair when clearing furnace state after rebase', async () => {
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

    const updater = updateFurnaceStateMock.mock.calls[0]?.[1];
    const repair = { operation: 'apply-rollback' as const, reason: 'test', timestamp: 'now' };
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by preceding mock access
    expect(updater!({ appliedChecksums: { x: 'a' }, pendingRepair: repair })).toEqual({
      pendingRepair: repair,
    });
  });

  it('does not clear furnace state when furnace-state.json is missing', async () => {
    hasActiveRebaseSessionMock.mockResolvedValue(false);
    pathExistsMock.mockImplementation((path: string) =>
      Promise.resolve(!path.includes('furnace-state.json'))
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
    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
  });

  it('does not clear furnace state during dry-run', async () => {
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

    expect(updateFurnaceStateMock).not.toHaveBeenCalled();
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
      toVersion: '140.9.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    });

    await rebaseCommand('/project', { abort: true });
    expect(resetChangesMock).toHaveBeenCalled();
    expect(clearRebaseSessionMock).toHaveBeenCalled();
  });

  it('requires confirmation when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    confirmMock.mockResolvedValue(false);
    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.9.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    });

    try {
      await rebaseCommand('/project', { abort: true });
      expect(confirmMock).toHaveBeenCalled();
      expect(resetChangesMock).not.toHaveBeenCalled();
    } finally {
      process.stdin.isTTY = origStdin;
      process.stdout.isTTY = origStdout;
    }
  });

  it('skips confirmation with --yes when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.9.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    });

    await rebaseCommand('/project', { abort: true, yes: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resetChangesMock).toHaveBeenCalled();
  });

  it('throws in non-interactive mode without --yes when engine is dirty', async () => {
    hasChangesMock.mockResolvedValue(true);
    const origStdin = process.stdin.isTTY;
    const origStdout = process.stdout.isTTY;
    process.stdin.isTTY = undefined as never;
    process.stdout.isTTY = undefined as never;

    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.9.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    });

    try {
      await expect(rebaseCommand('/project', { abort: true })).rejects.toBeInstanceOf(
        InvalidArgumentError
      );
    } finally {
      process.stdin.isTTY = origStdin;
      process.stdout.isTTY = origStdout;
    }
  });

  it('clears furnace state after abort resets the engine', async () => {
    loadRebaseSessionMock.mockResolvedValue({
      startedAt: '2026-01-01',
      fromVersion: '128.0esr',
      toVersion: '140.9.0esr',
      preRebaseCommit: 'abc123',
      patches: [],
      currentIndex: 0,
    });

    await rebaseCommand('/project', { abort: true });

    expect(resetChangesMock).toHaveBeenCalled();
    expect(updateFurnaceStateMock).toHaveBeenCalledTimes(1);
    const updater = updateFurnaceStateMock.mock.calls[0]?.[1];
    expect(typeof updater).toBe('function');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- guarded by expect above
    expect(updater!({ appliedChecksums: { 'custom/x/x.mjs': 'abc' } })).toEqual({});
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
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
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
      process.stdin.isTTY = origStdin;
      process.stdout.isTTY = origStdout;
    }
  });

  it('proceeds without confirmation when --yes is specified', async () => {
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

    await rebaseCommand('/project', { yes: true });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(resetChangesMock).toHaveBeenCalled();
  });

  it('throws in non-interactive mode with dirty engine and no --yes', async () => {
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
      process.stdin.isTTY = origStdin;
      process.stdout.isTTY = origStdout;
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

    expect(updatePatchAndMetadataMock).toHaveBeenCalledWith(
      '/project/patches',
      '001-branding.patch',
      'diff --git a/browser/file.txt b/browser/file.txt\n',
      { sourceEsrVersion: '140.9.0esr', sourceVersion: '140.9.0esr' }
    );
    expect(applyPatchWithFuzzMock).toHaveBeenCalledWith(
      '/project/patches/002-ui.patch',
      '/project/engine',
      3
    );
    // pendingResolution cleanup now uses the transactional updateState path.
    expect(updateStateMock).toHaveBeenCalled();
    expect(stampPatchVersionsMock).toHaveBeenCalledWith(
      '/project/patches',
      ['001-branding.patch', '002-ui.patch'],
      '140.9.0esr',
      undefined
    );
    expect(clearRebaseSessionMock).toHaveBeenCalled();
  });

  it('refuses to claim success when a per-patch re-export fails after a clean apply loop', async () => {
    // Apply succeeds for every patch; the post-apply re-export then fails
    // for the only patch that was applied. The previous behaviour silently
    // warn-and-continued through this, leaving the queue stamped with an
    // honest version but a stale .patch file. The new contract is to
    // throw a RebaseError, leave the session intact, and skip stamping.
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
    getDiffForFilesAgainstHeadMock.mockRejectedValue(new Error('git diff exploded'));

    await expect(rebaseCommand('/project')).rejects.toThrow(
      /Apply succeeded but 1 patch\(es\) failed to re-export/
    );

    expect(stampPatchVersionsMock).not.toHaveBeenCalled();
    expect(clearRebaseSessionMock).not.toHaveBeenCalled();
  });

  it('replays the post-apply pipeline when --continue resumes a session whose apply loop already finished', async () => {
    // currentIndex is already past the end → previous behaviour rejected
    // this as a "corrupt session" because no patch was in 'failed'. The
    // new branch routes straight back to runPatchLoop, which retries the
    // re-export + stamp + clear-session pipeline.
    loadRebaseSessionMock.mockResolvedValue({
      ...makeSession([{ filename: '001-branding.patch', status: 'applied-clean' }]),
      currentIndex: 1,
    });
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
    getDiffForFilesAgainstHeadMock.mockResolvedValue('diff --git a/file.txt b/file.txt\n');

    await rebaseCommand('/project', { continue: true });

    expect(applyPatchWithFuzzMock).not.toHaveBeenCalled();
    expect(stampPatchVersionsMock).toHaveBeenCalledWith(
      '/project/patches',
      ['001-branding.patch'],
      '140.9.0esr',
      undefined
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

    // --continue now uses transactional `updateState` for both writes: a
    // clear of pendingResolution (after the previous resolve) and a set
    // when the next patch fails mid-continue. Invoke the captured updaters
    // with representative state to verify the effective payloads.
    expect(updateStateMock).toHaveBeenCalled();
    const calls = updateStateMock.mock.calls;
    const clearCall = calls[0];
    expect(clearCall).toBeDefined();
    const clearUpdater = clearCall?.[1] as (
      current: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(
      clearUpdater({
        pendingResolution: { patchFilename: '001-branding.patch', originalError: 'x' },
      })
    ).toEqual({});

    const setCall = calls[calls.length - 1];
    expect(setCall).toBeDefined();
    const setUpdater = setCall?.[1] as (
      current: Record<string, unknown>
    ) => Record<string, unknown>;
    expect(setUpdater({})).toEqual({
      pendingResolution: {
        patchFilename: '002-ui.patch',
        originalError: 'patch failed again',
      },
    });

    expect(stampPatchVersionsMock).not.toHaveBeenCalled();
    expect(clearRebaseSessionMock).not.toHaveBeenCalled();
  });
});
