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

  it('succeeds when exit code is 0 even with non-fatal warnings in output', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: 'abort: no such remote origin',
      stderr: 'Traceback (most recent call last):\nHTTP Error 403: Forbidden',
      exitCode: 0,
    });

    await expect(bootstrapCommand('/project')).resolves.toBeUndefined();
    expect(outro).toHaveBeenCalledWith('Build dependencies installed successfully!');
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
});
