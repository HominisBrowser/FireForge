// SPDX-License-Identifier: EUPL-1.2
import { confirm } from '@clack/prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadConfig, loadState, saveState } from '../../core/config.js';
import { isGitRepository } from '../../core/git.js';
import { getStagedDiffForFiles } from '../../core/git-diff.js';
import { stageFiles, unstageFiles } from '../../core/git-file-ops.js';
import { updatePatch, updatePatchMetadata } from '../../core/patch-export.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { pathExists } from '../../utils/fs.js';
import { info } from '../../utils/logger.js';
import { resolveCommand } from '../resolve.js';

vi.mock('../../core/config.js', () => ({
  getProjectPaths: vi.fn().mockReturnValue({
    root: '/fake/root',
    engine: '/fake/engine',
    patches: '/fake/patches',
    config: '/fake/root/fireforge.json',
    fireforgeDir: '/fake/root/.fireforge',
    state: '/fake/root/.fireforge/state.json',
    configs: '/fake/root/configs',
    src: '/fake/root/src',
    componentsDir: '/fake/root/src/components',
  }),
  loadState: vi.fn(),
  saveState: vi.fn(),
  loadConfig: vi.fn(),
}));
vi.mock('../../core/git.js');
vi.mock('../../core/git-diff.js');
vi.mock('../../core/git-file-ops.js');
vi.mock('../../core/patch-export.js');
vi.mock('../../core/patch-manifest.js');
vi.mock('../../utils/fs.js');
vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi.fn().mockReturnValue({
    stop: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('@clack/prompts');

describe('resolveCommand', () => {
  const projectRoot = '/fake/root';

  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.clearAllMocks();
    // Simulate interactive terminal for resolve command
    process.stdin.isTTY = true;
    vi.mocked(loadConfig).mockResolvedValue({
      name: 'Test',
      vendor: 'Test',
      appId: 'test',
      binaryName: 'test',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    });
    vi.mocked(isGitRepository).mockResolvedValue(true);
    vi.mocked(pathExists).mockResolvedValue(true);
  });

  afterEach(() => {
    process.stdin.isTTY = originalIsTTY;
  });

  it('should exit if no pending resolution', async () => {
    vi.mocked(loadState).mockResolvedValue({});
    await resolveCommand(projectRoot);
    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
  });

  it('should successfully resolve a patch', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(getStagedDiffForFiles).mockResolvedValue('new diff');

    await resolveCommand(projectRoot);

    expect(stageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
    expect(updatePatch).toHaveBeenCalledWith(expect.any(String), 'new diff');
    expect(updatePatchMetadata).toHaveBeenCalledWith(
      expect.any(String),
      patchFilename,
      expect.objectContaining({
        sourceEsrVersion: '140.0esr',
      })
    );
    expect(saveState).toHaveBeenCalledWith(projectRoot, {});
  });

  it('should fail if no changes detected', async () => {
    const patchFilename = '001-test.patch';
    const pendingResolution = { patchFilename, originalError: 'error' };
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution,
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(getStagedDiffForFiles).mockResolvedValue('');

    await resolveCommand(projectRoot);

    expect(updatePatch).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      'No patch update was generated from the staged diff. Pending resolution was left intact so you can retry. To discard the resolution state, delete the "pendingResolution" key from state.json.'
    );
    expect(unstageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
  });

  it('persists missing-files metadata only after writing the refreshed patch', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js', 'file2.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(targetPath.endsWith('file1.js') || !targetPath.includes('/fake/engine/'))
    );
    vi.mocked(getStagedDiffForFiles).mockResolvedValue('new diff');

    await resolveCommand(projectRoot);

    expect(stageFiles).toHaveBeenCalledWith(expect.any(String), ['file1.js']);
    expect(updatePatch).toHaveBeenCalledWith(expect.any(String), 'new diff');
    expect(updatePatchMetadata).toHaveBeenCalledTimes(1);
    expect(updatePatchMetadata).toHaveBeenCalledWith(
      expect.any(String),
      patchFilename,
      expect.objectContaining({
        filesAffected: ['file1.js'],
        sourceEsrVersion: '140.0esr',
      })
    );
  });

  it('does not mutate the manifest when patch rewriting fails', async () => {
    const patchFilename = '001-test.patch';
    vi.mocked(loadState).mockResolvedValue({
      pendingResolution: { patchFilename, originalError: 'error' },
    });
    vi.mocked(confirm).mockResolvedValue(true);
    vi.mocked(loadPatchesManifest).mockResolvedValue({
      version: 1,
      patches: [
        {
          filename: patchFilename,
          filesAffected: ['file1.js', 'file2.js'],
          order: 1,
          category: 'ui',
          name: 'test',
          description: '',
          createdAt: '',
          sourceEsrVersion: '128.0esr',
        },
      ],
    });
    vi.mocked(pathExists).mockImplementation((targetPath) =>
      Promise.resolve(targetPath.endsWith('file1.js') || !targetPath.includes('/fake/engine/'))
    );
    vi.mocked(getStagedDiffForFiles).mockResolvedValue('new diff');
    vi.mocked(updatePatch).mockRejectedValue(new Error('disk full'));

    await expect(resolveCommand(projectRoot)).rejects.toThrow('disk full');

    expect(updatePatchMetadata).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });
});
