// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  }),
  getProjectPaths: vi.fn(),
  updateState: vi.fn().mockResolvedValue(undefined),
  loadState: vi.fn().mockResolvedValue({}),
}));

vi.mock('../../core/firefox.js', () => ({
  downloadFirefoxSource: vi.fn().mockResolvedValue(undefined),
  formatBytes: vi.fn((value: number) => `${value} B`),
}));

vi.mock('../../core/file-lock.js', () => ({
  withFileLock: vi.fn((_lockPath: string, operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../core/furnace-config.js', () => ({
  getFurnacePaths: vi.fn((root: string) => ({
    furnaceConfig: `${root}/furnace.json`,
    componentsDir: `${root}/components`,
    overridesDir: `${root}/components/overrides`,
    customDir: `${root}/components/custom`,
    furnaceState: `${root}/.fireforge/furnace-state.json`,
  })),
  updateFurnaceState: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/git.js')>();
  return {
    initRepository: vi.fn(),
    getHead: vi.fn(),
    isGitRepository: vi.fn().mockResolvedValue(true),
    resumeRepository: vi.fn(),
    isMissingHeadError: actual.isMissingHeadError,
  };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn((path: string) => Promise.resolve(path === '/project/engine')),
  pathExistsStrict: vi.fn((path: string) => Promise.resolve(path === '/project/engine')),
  removeDir: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  checkDiskSpace: vi.fn().mockResolvedValue(undefined),
}));

const mockRename = vi.hoisted(() => vi.fn<() => Promise<void>>().mockResolvedValue(undefined));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: mockRename,
  };
});

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
  info: vi.fn(),
  warn: vi.fn(),
  step: vi.fn(),
  verbose: vi.fn(),
}));

import { getProjectPaths } from '../../core/config.js';
import { withFileLock } from '../../core/file-lock.js';
import { downloadFirefoxSource } from '../../core/firefox.js';
import { updateFurnaceState } from '../../core/furnace-config.js';
import { getHead, initRepository, resumeRepository } from '../../core/git.js';
import { ChecksumMismatchError, EngineExistsError } from '../../errors/download.js';
import { pathExists, pathExistsStrict, removeDir } from '../../utils/fs.js';
import type { SpinnerHandle } from '../../utils/logger.js';
import { info, spinner, step, warn } from '../../utils/logger.js';
import { downloadCommand } from '../download.js';

function createSpinnerMock(): SpinnerHandle & {
  stopMock: ReturnType<typeof vi.fn<(msg?: string) => void>>;
  errorMock: ReturnType<typeof vi.fn<(msg?: string) => void>>;
  messageMock: ReturnType<typeof vi.fn<(msg: string) => void>>;
} {
  const messageMock = vi.fn<(msg: string) => void>();
  const stopMock = vi.fn<(msg?: string) => void>();
  const errorMock = vi.fn<(msg?: string) => void>();

  return {
    message: messageMock,
    stop: stopMock,
    error: errorMock,
    messageMock,
    stopMock,
    errorMock,
  };
}

describe('downloadCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRename.mockReset().mockResolvedValue(undefined);
    vi.mocked(downloadFirefoxSource).mockResolvedValue(undefined);
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');
    vi.mocked(resumeRepository).mockResolvedValue(undefined);
    vi.mocked(updateFurnaceState).mockResolvedValue(undefined);
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(withFileLock).mockImplementation((_lockPath, operation) => operation());
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );
    vi.mocked(pathExistsStrict).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );
  });

  it('restores the previous engine when forced git initialization fails after replacement', async () => {
    vi.mocked(initRepository).mockRejectedValue(new Error('git add failed'));

    await expect(downloadCommand('/project', { force: true })).rejects.toThrow('git add failed');

    expect(warn).toHaveBeenCalledWith(
      'Replacement engine/ failed during baseline git initialization. FireForge will try to restore the previous engine.'
    );
    expect(warn).toHaveBeenCalledWith(
      'Restored the previous engine/ after the forced replacement failed.'
    );
    expect(mockRename).toHaveBeenNthCalledWith(
      1,
      '/project/engine',
      expect.stringMatching(/^\/project\/engine\.backup-/)
    );
    expect(mockRename).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/project\/engine\.replacement-/),
      '/project/engine'
    );
    expect(mockRename).toHaveBeenNthCalledWith(
      3,
      expect.stringMatching(/^\/project\/engine\.backup-/),
      '/project/engine'
    );
  });

  it('surfaces a clearer error when rerunning download into an unborn engine repo without force', async () => {
    vi.mocked(getHead).mockRejectedValueOnce(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );
    vi.mocked(resumeRepository).mockRejectedValueOnce(new Error('resume failed'));

    await expect(downloadCommand('/project', {})).rejects.toThrow(
      'Engine directory contains a partially initialized checkout: /project/engine'
    );

    expect(initRepository).not.toHaveBeenCalled();
  });

  it('preserves the underlying resume failure as the PartialEngineExistsError cause', async () => {
    vi.mocked(getHead).mockRejectedValueOnce(
      new Error(
        "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
      )
    );
    const underlying = new Error('socket hang up');
    vi.mocked(resumeRepository).mockRejectedValueOnce(underlying);

    let captured: unknown;
    try {
      await downloadCommand('/project', {});
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    const fireforgeError = captured as { cause?: unknown; userMessage?: string };
    expect(fireforgeError.cause).toBe(underlying);
    expect(fireforgeError.userMessage).toContain('socket hang up');
    expect(fireforgeError.userMessage).toContain('--verbose');
  });

  it('resumes a partially initialized repository and records the resumed base commit', async () => {
    const resumeSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(resumeSpinner);
    vi.mocked(getHead)
      .mockRejectedValueOnce(
        new Error(
          "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
        )
      )
      .mockResolvedValueOnce('base-commit');
    vi.mocked(resumeRepository).mockImplementation((_engineDir, options) => {
      options?.onProgress?.('git add -A');
      return Promise.resolve();
    });

    const originalStdoutTTY = process.stdout.isTTY;
    const originalStderrTTY = process.stderr.isTTY;
    process.stdout.isTTY = false;
    process.stderr.isTTY = false;

    try {
      await downloadCommand('/project', {});
    } finally {
      process.stdout.isTTY = originalStdoutTTY;
      process.stderr.isTTY = originalStderrTTY;
    }

    expect(resumeRepository).toHaveBeenCalledWith('/project/engine', expect.any(Object));
    // Progress messages now flow through the spinner handle exclusively —
    // the non-TTY spinner fallback emits `p.log.step(msg)` internally,
    // so the explicit `step()` call that used to sit alongside
    // `.message()` was removed in 0.16.0 (it had been double-printing
    // every git-init progress line in CI logs).
    expect(resumeSpinner.messageMock).toHaveBeenCalledWith('git add -A');
    expect(step).not.toHaveBeenCalledWith('git add -A');
  });

  it('throws EngineExistsError when a valid engine checkout already exists without force', async () => {
    await expect(downloadCommand('/project', {})).rejects.toBeInstanceOf(EngineExistsError);

    expect(withFileLock).toHaveBeenCalledWith(
      '/project/.fireforge/download.fireforge.lock',
      expect.any(Function)
    );
    expect(removeDir).not.toHaveBeenCalled();
    expect(initRepository).not.toHaveBeenCalled();
  });

  it('clears furnace state after --force activates a replacement engine', async () => {
    // Engine exists AND furnace-state.json exists → force branch should clear it after activation.
    vi.mocked(pathExistsStrict).mockResolvedValue(true);
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (path === '/project/.fireforge/furnace-state.json') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', { force: true });

    expect(downloadFirefoxSource).toHaveBeenCalledWith(
      '140.9.0esr',
      'firefox-esr',
      expect.stringMatching(/^\/project\/engine\.replacement-/),
      '/project/.fireforge/cache',
      expect.any(Function),
      expect.any(Function),
      undefined,
      expect.any(Function)
    );
    expect(removeDir).not.toHaveBeenCalledWith('/project/engine');
    expect(updateFurnaceState).toHaveBeenCalledTimes(1);
    const call = vi.mocked(updateFurnaceState).mock.calls[0];
    expect(call).toBeDefined();
    const updater = call?.[1];
    expect(typeof updater).toBe('function');
    if (typeof updater === 'function') {
      expect(updater({ appliedChecksums: { 'custom|foo/bar': 'hash' } })).toEqual({});
    }
  });

  it('preserves pendingRepair when --force clears stale furnace apply state', async () => {
    vi.mocked(pathExistsStrict).mockResolvedValue(true);
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (path === '/project/.fireforge/furnace-state.json') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', { force: true });

    const call = vi.mocked(updateFurnaceState).mock.calls[0];
    expect(call).toBeDefined();
    const updater = call?.[1];
    expect(typeof updater).toBe('function');
    if (typeof updater === 'function') {
      expect(
        updater({
          lastApply: '2026-04-12T00:00:00.000Z',
          appliedChecksums: { 'custom|foo/bar': 'hash' },
          pendingRepair: {
            operation: 'override-rollback',
            timestamp: '2026-04-12T01:02:03.000Z',
            reason: 'workspace authoring incomplete',
          },
        })
      ).toEqual({
        pendingRepair: {
          operation: 'override-rollback',
          timestamp: '2026-04-12T01:02:03.000Z',
          reason: 'workspace authoring incomplete',
        },
      });
    }
  });

  it('does not try to clear furnace state when it does not exist', async () => {
    vi.mocked(pathExistsStrict).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', { force: true });

    expect(removeDir).not.toHaveBeenCalledWith('/project/engine');
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('keeps the existing engine when forced download fails checksum validation before extraction', async () => {
    const mismatch = new ChecksumMismatchError(
      'firefox-devedition',
      '0'.repeat(64),
      '1'.repeat(64),
      'https://archive.mozilla.org/pub/devedition/releases/152.0b6/source/firefox-152.0b6.source.tar.xz'
    );
    vi.mocked(pathExistsStrict).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(downloadFirefoxSource).mockRejectedValueOnce(mismatch);

    await expect(downloadCommand('/project', { force: true })).rejects.toBe(mismatch);

    expect(removeDir).not.toHaveBeenCalledWith('/project/engine');
    expect(mockRename).not.toHaveBeenCalled();
    expect(initRepository).not.toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('emits download progress only for new 5 percent boundaries', async () => {
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(downloadSpinner).mockReturnValueOnce(gitSpinner);
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(downloadFirefoxSource).mockImplementation(
      (
        _version,
        _product,
        _engineDir,
        _cacheDir,
        onProgress,
        _onPhase,
        _sha256,
        onPhaseProgress
      ) => {
        onPhaseProgress?.('Validating source archive cache metadata for firefox.tar.xz...');
        onPhaseProgress?.('Writing source archive cache metadata for firefox.tar.xz.json...');
        onProgress?.(1, 0);
        onProgress?.(1, 100);
        onProgress?.(4, 100);
        onProgress?.(5, 100);
        onProgress?.(5, 100);
        onProgress?.(10, 100);
        return Promise.resolve();
      }
    );
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(downloadSpinner.messageMock).toHaveBeenCalledTimes(4);
    expect(downloadSpinner.messageMock).toHaveBeenCalledWith(
      'Validating source archive cache metadata for firefox.tar.xz...'
    );
    expect(downloadSpinner.messageMock).toHaveBeenCalledWith(
      'Writing source archive cache metadata for firefox.tar.xz.json...'
    );
    expect(downloadSpinner.messageMock).toHaveBeenNthCalledWith(
      3,
      'Downloading Firefox 140.9.0esr... 5% (5 B / 100 B)'
    );
    expect(downloadSpinner.messageMock).toHaveBeenNthCalledWith(
      4,
      'Downloading Firefox 140.9.0esr... 10% (10 B / 100 B)'
    );
  });

  it('emits the indexing-banner before starting the git init spinner (Finding #17)', async () => {
    // Finding #17: the git-add phase can run silently for minutes. The
    // new banner fires BEFORE the spinner so CI log tails and non-TTY
    // shells show expected-duration guidance even when the spinner's
    // interactive updates are suppressed. `info` is the channel used
    // (unlike spinner.message, which is interactive-only).
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(downloadSpinner).mockReturnValueOnce(gitSpinner);
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Indexing downloaded source into git')
    );
  });

  it('forwards indexing phase progress from git initialization', async () => {
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(downloadSpinner).mockReturnValueOnce(gitSpinner);
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(initRepository).mockImplementation((_engineDir, _branch, options) => {
      options?.onProgress?.('Git phase: initializing source git repository.');
      options?.onProgress?.('Scanning Firefox source tree before indexing...');
      options?.onProgress?.('Git phase: starting git add -A source indexing.');
      options?.onProgress?.('Source scan complete: 24 top-level directories, 12 top-level files');
      options?.onProgress?.(
        'Starting monolithic git add -A for 24 directories and 12 top-level files...'
      );
      options?.onProgress?.('Indexing Firefox source (monolithic, 15s elapsed)');
      options?.onProgress?.('Git phase complete: git add -A source indexing finished.');
      options?.onProgress?.('Git phase: creating initial source commit.');
      options?.onProgress?.('Creating initial Firefox source commit...');
      return Promise.resolve();
    });
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Scanning Firefox source tree before indexing...'
    );
    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Git phase: starting git add -A source indexing.'
    );
    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Source scan complete: 24 top-level directories, 12 top-level files'
    );
    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Indexing Firefox source (monolithic, 15s elapsed)'
    );
    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Creating initial Firefox source commit...'
    );
    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Git phase: creating initial source commit.'
    );
  });

  it('stops the restore spinner with a no-op message when the patch queue is empty', async () => {
    // Finding #4: pre-0.16.0 `download` always closed the restore
    // spinner with "Patch-touched files restored" even when the project
    // had zero patches. Operators reading the output thought a restore
    // had happened on a workspace that had never exported a patch. The
    // fix routes an empty-queue result through a dedicated stop message.
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    const restoreSpinner = createSpinnerMock();
    vi.mocked(spinner)
      .mockReturnValueOnce(downloadSpinner)
      .mockReturnValueOnce(gitSpinner)
      .mockReturnValueOnce(restoreSpinner);
    // patches dir absent → getPatchTouchedFiles returns an empty set →
    // cleanPatchTouchedFiles reports hadQueue: false.
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(restoreSpinner.stopMock).toHaveBeenCalledWith(
      'No patches in queue — nothing to restore'
    );
    expect(restoreSpinner.stopMock).not.toHaveBeenCalledWith('Patch-touched files restored');
  });

  it('passes a pinned firefox.sha256 through to the archive downloader', async () => {
    const configMod = await import('../../core/config.js');
    vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
      firefox: {
        version: '140.9.0esr',
        product: 'firefox-esr',
        sha256: 'a'.repeat(64),
      },
      name: 'Fire',
      vendor: 'Forge',
      appId: 'org.example.fireforge',
      binaryName: 'fireforge',
    });
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(downloadFirefoxSource).toHaveBeenCalledWith(
      '140.9.0esr',
      'firefox-esr',
      '/project/engine',
      '/project/.fireforge/cache',
      expect.any(Function),
      expect.any(Function),
      'a'.repeat(64),
      expect.any(Function)
    );
  });

  describe('major-version-hop toolchain notice', () => {
    const hopNotice = expect.stringContaining('fireforge bootstrap') as unknown as string;

    it('prints the notice when --force hops the Firefox major version (152 → 153 drill)', async () => {
      const configMod = await import('../../core/config.js');
      vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
        firefox: { version: '153.0b8', product: 'firefox-beta' },
        name: 'Fire',
        vendor: 'Forge',
        appId: 'org.example.fireforge',
        binaryName: 'fireforge',
      });
      vi.mocked(configMod.loadState).mockResolvedValueOnce({ downloadedVersion: '152.0b7' });

      await downloadCommand('/project', { force: true });

      expect(info).toHaveBeenCalledWith(expect.stringContaining('152 → 153'));
      expect(info).toHaveBeenCalledWith(hopNotice);
    });

    it('stays quiet on a same-version re-download', async () => {
      const configMod = await import('../../core/config.js');
      vi.mocked(configMod.loadState).mockResolvedValueOnce({ downloadedVersion: '140.9.0esr' });

      await downloadCommand('/project', { force: true });

      expect(info).not.toHaveBeenCalledWith(hopNotice);
    });

    it('stays quiet on a first download with no recorded state', async () => {
      vi.mocked(pathExistsStrict).mockResolvedValue(false);
      vi.mocked(pathExists).mockResolvedValue(false);

      await downloadCommand('/project', {});

      expect(info).not.toHaveBeenCalledWith(hopNotice);
    });

    it('prints the notice on the resume path when state predates the configured major', async () => {
      const configMod = await import('../../core/config.js');
      vi.mocked(configMod.loadConfig).mockResolvedValueOnce({
        firefox: { version: '153.0b8', product: 'firefox-beta' },
        name: 'Fire',
        vendor: 'Forge',
        appId: 'org.example.fireforge',
        binaryName: 'fireforge',
      });
      vi.mocked(configMod.loadState).mockResolvedValueOnce({ downloadedVersion: '152.0b7' });
      // No --force + a HEAD probe failing with the unborn-branch shape
      // routes into the resume path.
      vi.mocked(getHead)
        .mockRejectedValueOnce(
          new Error(
            "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."
          )
        )
        .mockResolvedValue('resumed-commit');

      await downloadCommand('/project', {});

      expect(info).toHaveBeenCalledWith(hopNotice);
    });
  });
});
