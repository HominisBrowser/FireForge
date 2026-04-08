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

vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
  buildArtifactMismatchMessage: vi.fn(() => undefined),
  run: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  removeDir: vi.fn(),
  removeFile: vi.fn(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  info: vi.fn(),
  verbose: vi.fn(),
}));

import { readdir } from 'node:fs/promises';

import { buildArtifactMismatchMessage, hasBuildArtifacts, run } from '../../core/mach.js';
import { pathExists, removeDir, removeFile } from '../../utils/fs.js';
import { verbose } from '../../utils/logger.js';
import { runCommand } from '../run.js';

describe('runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
  });

  it('does not treat Ctrl+C as a build failure', async () => {
    vi.mocked(run).mockResolvedValue(130);

    await expect(runCommand('/project')).resolves.toBeUndefined();
  });

  it('fails before launching when build artifacts are missing', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: false });

    await expect(runCommand('/project')).rejects.toThrow(/Run requires a completed build/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails before launching when build artifacts belong to another workspace', async () => {
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Run cannot use copied or relocated build artifacts'
    );

    await expect(runCommand('/project')).rejects.toThrow(/copied or relocated build artifacts/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('still throws for real non-interrupt exits', async () => {
    vi.mocked(run).mockResolvedValue(1);

    await expect(runCommand('/project')).rejects.toThrow(/Browser exited with code 1/);
  });

  it('cleans startupCache and parentlock when obj dirs exist', async () => {
    vi.mocked(readdir).mockResolvedValue(['obj-debug'] as unknown as Awaited<
      ReturnType<typeof readdir>
    >);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(run).mockResolvedValue(0);

    await expect(runCommand('/project')).resolves.toBeUndefined();

    expect(removeDir).toHaveBeenCalledWith(expect.stringContaining('startupCache'));
    expect(removeFile).toHaveBeenCalledWith(expect.stringContaining('.parentlock'));
  });

  it('handles cleanDevProfile errors non-fatally', async () => {
    vi.mocked(readdir).mockRejectedValue(new Error('EACCES'));
    vi.mocked(run).mockResolvedValue(0);

    await expect(runCommand('/project')).resolves.toBeUndefined();

    expect(verbose).toHaveBeenCalledWith(
      expect.stringContaining('Non-fatal dev profile cleanup failure')
    );
  });

  it('throws when engine directory is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(runCommand('/project')).rejects.toThrow(/Firefox source not found/);
    expect(run).not.toHaveBeenCalled();
  });

  it('throws AmbiguousBuildArtifactsError when build is ambiguous', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: false,
      ambiguous: true,
      objDirs: ['obj-debug', 'obj-release'],
    });

    await expect(runCommand('/project')).rejects.toThrow(/Multiple build artifact directories/i);
    expect(run).not.toHaveBeenCalled();
  });

  it('includes objDir in error when build is incomplete', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: false,
      objDir: 'obj-debug',
    });

    await expect(runCommand('/project')).rejects.toThrow(/Build artifacts incomplete in obj-debug/);
  });

  it('does not throw for SIGTERM exit code (143)', async () => {
    vi.mocked(run).mockResolvedValue(143);

    await expect(runCommand('/project')).resolves.toBeUndefined();
  });

  it('does not throw for clean exit (code 0)', async () => {
    vi.mocked(run).mockResolvedValue(0);

    await expect(runCommand('/project')).resolves.toBeUndefined();
  });
});
