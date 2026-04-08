// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(),
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
  machPackage: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
}));

vi.mock('../../core/brand-validation.js', () => ({
  validateBrandOverride: vi.fn(),
}));

vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(),
}));

import { validateBrandOverride } from '../../core/brand-validation.js';
import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { buildArtifactMismatchMessage, hasBuildArtifacts, machPackage } from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, verbose } from '../../utils/logger.js';
import { packageCommand, registerPackage } from '../package.js';

function createProgram(): Command {
  const program = new Command();

  registerPackage(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

describe('packageCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(prepareBuildEnvironment).mockResolvedValue({ furnaceApplied: 0 });
    vi.mocked(machPackage).mockResolvedValue(0);
  });

  it('requires a completed build before packaging', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: false, objDir: 'obj-debug' });

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Packaging requires a completed build.'
    );

    expect(machPackage).not.toHaveBeenCalled();
  });

  it('fails before packaging when the engine checkout is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Firefox source not found. Run "fireforge download" first.'
    );

    expect(machPackage).not.toHaveBeenCalled();
  });

  it('rejects ambiguous build artifact discovery before invoking mach', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-debug', 'obj-release'],
    });

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Multiple build artifact directories found: obj-debug, obj-release'
    );

    expect(machPackage).not.toHaveBeenCalled();
  });

  it('rejects copied or relocated build artifacts before invoking mach', async () => {
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Package cannot use copied or relocated build artifacts.'
    );

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Package cannot use copied or relocated build artifacts.'
    );

    expect(machPackage).not.toHaveBeenCalled();
  });

  it('wraps package startup failures with build context', async () => {
    vi.mocked(machPackage).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(packageCommand('/project', {})).rejects.toThrow('Package process failed to start');
  });

  it('packages successfully after the shared build preparation runs', async () => {
    await expect(packageCommand('/project', { brand: 'stable' })).resolves.toBeUndefined();

    expect(prepareBuildEnvironment).toHaveBeenCalledWith(
      '/project',
      makeProjectPaths(),
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'stable');
    expect(verbose).toHaveBeenCalledWith('Packaging with brand: stable');
    expect(info).toHaveBeenCalledWith('Brand: stable');
    expect(machPackage).toHaveBeenCalledWith('/project/engine');
    expect(info).toHaveBeenCalledWith('\nPackage created in obj-*/dist/');
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('Packaging completed in'));
  });

  it('treats non-zero package exits as build failures', async () => {
    vi.mocked(machPackage).mockResolvedValue(1);

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Packaging failed with exit code 1'
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Packaging failed after'));
  });
});

describe('registerPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(prepareBuildEnvironment).mockResolvedValue({ furnaceApplied: 0 });
    vi.mocked(machPackage).mockResolvedValue(0);
  });

  it('routes parsed CLI options through the registered action', async () => {
    const program = createProgram();

    await program.parseAsync(['node', 'test', 'package', '--brand', 'stable']);

    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'stable');
    expect(machPackage).toHaveBeenCalledWith('/project/engine');
  });
});
