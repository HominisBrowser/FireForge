// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    firefox: { version: '140.0esr', product: 'firefox-esr' },
  }),
  getProjectPaths: vi.fn(),
  updateState: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../core/firefox.js', () => ({
  downloadFirefoxSource: vi.fn().mockResolvedValue(undefined),
  formatBytes: vi.fn((value: number) => `${value} B`),
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
  removeDir: vi.fn().mockResolvedValue(undefined),
  ensureDir: vi.fn().mockResolvedValue(undefined),
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
}));

import { getProjectPaths } from '../../core/config.js';
import { downloadFirefoxSource } from '../../core/firefox.js';
import { getHead, initRepository, resumeRepository } from '../../core/git.js';
import { EngineExistsError } from '../../errors/download.js';
import { pathExists, removeDir } from '../../utils/fs.js';
import type { SpinnerHandle } from '../../utils/logger.js';
import { spinner, step, warn } from '../../utils/logger.js';
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
    vi.mocked(pathExists).mockImplementation((path: string) =>
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
    expect(step).toHaveBeenCalledWith('git add -A');
  });

  it('throws EngineExistsError when a valid engine checkout already exists without force', async () => {
    await expect(downloadCommand('/project', {})).rejects.toBeInstanceOf(EngineExistsError);

    expect(removeDir).not.toHaveBeenCalled();
    expect(initRepository).not.toHaveBeenCalled();
  });

  it('emits download progress only for new 5 percent boundaries', async () => {
    const downloadSpinner = createSpinnerMock();
    const gitSpinner = createSpinnerMock();
    vi.mocked(spinner).mockReturnValueOnce(downloadSpinner).mockReturnValueOnce(gitSpinner);
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
      'Downloading Firefox 140.0esr... 5% (5 B / 100 B)'
    );
    expect(downloadSpinner.messageMock).toHaveBeenNthCalledWith(
      2,
      'Downloading Firefox 140.0esr... 10% (10 B / 100 B)'
    );
  });
});
