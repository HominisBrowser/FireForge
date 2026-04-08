// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

const loggerState = vi.hoisted(() => ({
  spinnerStop: vi.fn(),
  spinnerError: vi.fn(),
}));

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(),
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/mach.js', () => ({
  generateMozconfig: vi.fn(),
  hasBuildArtifacts: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
  watchWithOutput: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/process.js', () => ({
  executableExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: loggerState.spinnerStop,
    error: loggerState.spinnerError,
  })),
}));

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  buildArtifactMismatchMessage,
  generateMozconfig,
  hasBuildArtifacts,
  watchWithOutput,
} from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { outro } from '../../utils/logger.js';
import { executableExists } from '../../utils/process.js';
import { watchCommand } from '../watch.js';

describe('watchCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerState.spinnerStop.mockReset();
    loggerState.spinnerError.mockReset();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(executableExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(generateMozconfig).mockResolvedValue(undefined);
    vi.mocked(watchWithOutput).mockResolvedValue({ stdout: '', stderr: '', exitCode: 130 });
  });

  it('requires watchman to be installed before starting watch mode', async () => {
    vi.mocked(executableExists).mockResolvedValue(false);

    await expect(watchCommand('/project')).rejects.toThrow(
      'Watch mode requires watchman to be installed and available in PATH.'
    );

    expect(watchWithOutput).not.toHaveBeenCalled();
  });

  it('requires a completed build before starting watch mode', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: false, objDir: 'obj-debug' });

    await expect(watchCommand('/project')).rejects.toThrow(
      'Watch mode requires a completed build.'
    );

    expect(generateMozconfig).not.toHaveBeenCalled();
    expect(watchWithOutput).not.toHaveBeenCalled();
  });

  it('translates configure-time watchman failures into actionable guidance', async () => {
    vi.mocked(watchWithOutput).mockResolvedValue({
      stdout: 'watchman was not available when the current build was configured',
      stderr: '',
      exitCode: 1,
    });

    await expect(watchCommand('/project')).rejects.toThrow(
      'Install watchman, delete the current obj-* directory, run "fireforge build" again, then retry "fireforge watch".'
    );
  });

  it('treats Ctrl+C exits as a normal stop condition', async () => {
    await expect(watchCommand('/project')).resolves.toBeUndefined();

    expect(generateMozconfig).toHaveBeenCalledWith(
      '/project/configs',
      '/project/engine',
      expect.anything()
    );
    expect(watchWithOutput).toHaveBeenCalledWith('/project/engine');
    expect(outro).toHaveBeenCalledWith('Watch mode stopped');
  });
});
