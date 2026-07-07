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
  warn: vi.fn(),
  success: vi.fn(),
}));

vi.mock('../bootstrap-checks.js', () => ({
  detectBootstrapIssues: vi.fn(() => []),
  runPostBootstrapChecks: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../doctor.js', () => ({
  reportDoctorResults: vi.fn(() => 0),
}));

import { bootstrapWithOutput } from '../../core/mach.js';
import { ExitCode } from '../../errors/codes.js';
import { error, outro, warn } from '../../utils/logger.js';
import { bootstrapCommand } from '../bootstrap.js';
import { detectBootstrapIssues, runPostBootstrapChecks } from '../bootstrap-checks.js';
import { reportDoctorResults } from '../doctor.js';

describe('bootstrapCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('succeeds only when bootstrap exits cleanly without fatal output', async () => {
    await expect(bootstrapCommand('/project')).resolves.toBe(ExitCode.SUCCESS);
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

  it('runs post-bootstrap checks on soft failures and reports warnings', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: 'abort: no such remote origin',
      stderr: 'Traceback (most recent call last):\nHTTP Error 403: Forbidden',
      exitCode: 0,
    });

    vi.mocked(detectBootstrapIssues).mockReturnValue(['sdk-fetch-403', 'missing-origin-remote']);
    vi.mocked(runPostBootstrapChecks).mockResolvedValue([
      {
        name: 'macOS SDK download',
        passed: true,
        severity: 'warning',
        warning: true,
        message: 'safe to ignore',
      },
      { name: 'Git remote', passed: false, severity: 'error', message: 'missing origin' },
    ]);

    await expect(bootstrapCommand('/project')).resolves.toBe(ExitCode.SUCCESS);
    expect(warn).toHaveBeenCalledWith('Bootstrap completed with issues:');
    expect(outro).toHaveBeenCalledWith('Build dependencies installed with errors');
  });

  it('reports warnings-only when all post-bootstrap checks are non-critical', async () => {
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      stdout: 'urllib.error.HTTPError: HTTP Error 403: Forbidden\n',
      stderr: '',
      exitCode: 0,
    });

    vi.mocked(detectBootstrapIssues).mockReturnValue(['sdk-fetch-403']);
    vi.mocked(runPostBootstrapChecks).mockResolvedValue([
      {
        name: 'macOS SDK download',
        passed: true,
        severity: 'warning',
        warning: true,
        message: 'safe to ignore',
      },
    ]);

    await expect(bootstrapCommand('/project')).resolves.toBe(ExitCode.SUCCESS);
    expect(warn).toHaveBeenCalledWith('Bootstrap completed with warnings:');
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

  it('returns a non-success exit code when post-bootstrap checks report errors', async () => {
    // Discarding reportDoctorResults' return used to make bootstrap exit 0
    // with error-severity failures — CI gating on bootstrap then proceeded
    // to a build that could not succeed.
    vi.mocked(bootstrapWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'HTTP 403 while fetching artifact',
      stderr: '',
    });
    vi.mocked(detectBootstrapIssues).mockReturnValue(['sdk-fetch-403']);
    vi.mocked(runPostBootstrapChecks).mockResolvedValue([
      { name: 'Artifact fetch', passed: false, severity: 'error', message: '403' },
    ] as never);
    vi.mocked(reportDoctorResults).mockReturnValue(ExitCode.GENERAL_ERROR);

    await expect(bootstrapCommand('/project')).resolves.toBe(ExitCode.GENERAL_ERROR);
  });
});
