// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
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

vi.mock('../../core/git.js', () => ({
  ensureOriginRemote: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/mach.js', () => ({
  bootstrapWithOutput: vi.fn(() => Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}));

import { bootstrapWithOutput } from '../../core/mach.js';
import { error, outro } from '../../utils/logger.js';
import { bootstrapCommand } from '../bootstrap.js';

describe('bootstrapCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds only when bootstrap exits cleanly without fatal output', async () => {
    await expect(bootstrapCommand('/project')).resolves.toBeUndefined();
    expect(outro).toHaveBeenCalledWith('Build dependencies installed successfully!');
  });

  it('fails on non-zero exit codes', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: '',
      stderr: 'bootstrap failed',
      exitCode: 1,
    });

    await expect(bootstrapCommand('/project')).rejects.toThrow(/Bootstrap failed/i);
    expect(error).toHaveBeenCalledWith('Bootstrap failed');
  });

  it('succeeds when exit code is 0 but surfaces soft failures prominently', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: 'abort: no such remote origin',
      stderr: 'Traceback (most recent call last):\nHTTP Error 403: Forbidden',
      exitCode: 0,
    });

    await expect(bootstrapCommand('/project')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Bootstrap completed with issues:');
    expect(outro).toHaveBeenCalledWith('Build dependencies installed with warnings');
  });

  it('includes diagnostic details when exit code is non-zero and output has known patterns', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: '',
      stderr: 'Traceback (most recent call last):\nHTTP Error 403: Forbidden',
      exitCode: 1,
    });

    await expect(bootstrapCommand('/project')).rejects.toThrow(
      /Bootstrap did not complete successfully/i
    );
    expect(error).toHaveBeenCalledWith('Bootstrap failed');
  });

  it('throws a plain BootstrapError when exit code is non-zero but output has no known patterns', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: 'some random noise\n',
      stderr: 'unknown failure\n',
      exitCode: 1,
    });

    await expect(bootstrapCommand('/project')).rejects.toThrow(/Bootstrap failed/i);
    expect(error).toHaveBeenCalledWith('Bootstrap failed');
  });

  it('detects the Python urllib HTTP 403 pattern from real mach bootstrap output', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout:
        'urllib.error.HTTPError: HTTP Error 403: Forbidden\n' +
        'Your system should be ready to build Firefox for Desktop!\n',
      stderr: '',
      exitCode: 0,
    });

    await expect(bootstrapCommand('/project')).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Bootstrap completed with issues:');
    expect(outro).toHaveBeenCalledWith('Build dependencies installed with warnings');
  });
});
