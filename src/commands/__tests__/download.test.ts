// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
  }),
  getProjectPaths: vi.fn(),
  updateState: vi.fn().mockResolvedValue(undefined),
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
import { EngineExistsError } from '../../errors/download.js';
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
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(withFileLock).mockImplementation((_lockPath, operation) => operation());
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );
    vi.mocked(pathExistsStrict).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );
  });

  it('warns that force is required after partial git initialization failure', async () => {
    vi.mocked(initRepository).mockRejectedValue(new Error('git add failed'));

    await expect(downloadCommand('/project', { force: true })).rejects.toThrow('git add failed');

    expect(warn).toHaveBeenCalledWith(
      'engine/ may now contain a partially initialized git repository. Re-run "fireforge download --force" to recreate the baseline cleanly.'
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

  it('clears furnace state when --force removes an existing engine', async () => {
    // Engine exists AND furnace-state.json exists → force branch should clear it.
    vi.mocked(pathExistsStrict).mockResolvedValue(true);
    vi.mocked(pathExists).mockImplementation((path: string) => {
      if (path === '/project/.fireforge/furnace-state.json') return Promise.resolve(true);
      return Promise.resolve(false);
    });
    vi.mocked(initRepository).mockResolvedValue(undefined);
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', { force: true });

    expect(removeDir).toHaveBeenCalledWith('/project/engine');
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

    expect(removeDir).toHaveBeenCalled();
    expect(updateFurnaceState).not.toHaveBeenCalled();
  });

  it('emits download progress only for new 5 percent boundaries', async () => {
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(downloadSpinner).mockReturnValueOnce(gitSpinner);
    vi.mocked(pathExistsStrict).mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(false);
    vi.mocked(downloadFirefoxSource).mockImplementation(
      (_version, _product, _engineDir, _cacheDir, onProgress) => {
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

    expect(downloadSpinner.messageMock).toHaveBeenCalledTimes(2);
    expect(downloadSpinner.messageMock).toHaveBeenNthCalledWith(
      1,
      'Downloading Firefox 140.9.0esr... 5% (5 B / 100 B)'
    );
    expect(downloadSpinner.messageMock).toHaveBeenNthCalledWith(
      2,
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
      options?.onProgress?.('Scanning Firefox source tree before indexing...');
      options?.onProgress?.('Source scan complete: 24 top-level directories, 12 top-level files');
      options?.onProgress?.(
        'Starting monolithic git add -A for 24 directories and 12 top-level files...'
      );
      options?.onProgress?.('Indexing Firefox source (monolithic, 15s elapsed)');
      options?.onProgress?.('Creating initial Firefox source commit...');
      return Promise.resolve();
    });
    vi.mocked(getHead).mockResolvedValue('base-commit');

    await downloadCommand('/project', {});

    expect(gitSpinner.messageMock).toHaveBeenCalledWith(
      'Scanning Firefox source tree before indexing...'
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
});
