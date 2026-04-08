// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(),
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/mach.js', () => ({
  build: vi.fn(),
  buildUI: vi.fn(),
  hasBuildArtifacts: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
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
import {
  build,
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
} from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, verbose } from '../../utils/logger.js';
import { buildCommand, registerBuild } from '../build.js';

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();

  registerBuild(program, {
    getProjectRoot: () => '/project',
    withErrorHandling: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
  });

  return program;
}

describe('buildCommand', () => {
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
    vi.mocked(build).mockResolvedValue(0);
    vi.mocked(buildUI).mockResolvedValue(0);
  });

  it('fails before starting when the engine checkout is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(buildCommand('/project', {})).rejects.toThrow(
      'Firefox source not found. Run "fireforge download" first.'
    );

    expect(build).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();
  });

  it('rejects copied or relocated build artifacts before invoking mach', async () => {
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Build cannot use copied or relocated build artifacts.'
    );

    await expect(buildCommand('/project', {})).rejects.toThrow(
      'Build cannot use copied or relocated build artifacts.'
    );

    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('runs UI-only builds through buildUI after the shared preflight completes', async () => {
    await expect(buildCommand('/project', { ui: true, brand: 'beta' })).resolves.toBeUndefined();

    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'beta');
    expect(prepareBuildEnvironment).toHaveBeenCalledWith(
      '/project',
      makeProjectPaths(),
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(buildUI).toHaveBeenCalledWith('/project/engine');
    expect(build).not.toHaveBeenCalled();
    expect(verbose).toHaveBeenCalledWith('Building with brand: beta');
    expect(info).toHaveBeenCalledWith('Brand: beta');
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('Build completed in'));
  });

  it('uses build.jobs from config when the CLI does not override it', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      build: { jobs: 12 },
    } as never);

    await expect(buildCommand('/project', {})).resolves.toBeUndefined();

    expect(build).toHaveBeenCalledWith('/project/engine', 12);
    expect(info).toHaveBeenCalledWith('Using 12 parallel jobs');
  });

  it('prefers the CLI jobs value over build.jobs from config', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.0esr', product: 'firefox-esr' },
      build: { jobs: 12 },
    } as never);

    await expect(buildCommand('/project', { jobs: 6 })).resolves.toBeUndefined();

    expect(build).toHaveBeenCalledWith('/project/engine', 6);
    expect(info).toHaveBeenCalledWith('Using 6 parallel jobs');
  });

  it('rejects invalid job counts before invoking mach', async () => {
    await expect(buildCommand('/project', { jobs: 0 })).rejects.toThrow(
      'Build jobs must be a positive integer'
    );

    expect(build).not.toHaveBeenCalled();
  });

  it('wraps non-zero mach exits as build failures', async () => {
    vi.mocked(build).mockResolvedValue(2);

    await expect(buildCommand('/project', { jobs: 8 })).rejects.toThrow(
      'Build failed with exit code 2'
    );

    expect(build).toHaveBeenCalledWith('/project/engine', 8);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Build failed after'));
  });

  it('wraps startup failures before mach returns an exit code', async () => {
    vi.mocked(build).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(buildCommand('/project', { jobs: 4 })).rejects.toThrow(
      'Build process failed to start'
    );

    expect(error).not.toHaveBeenCalled();
  });
});

describe('registerBuild', () => {
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
    vi.mocked(build).mockResolvedValue(0);
    vi.mocked(buildUI).mockResolvedValue(0);
  });

  it('routes parsed CLI options through the registered action', async () => {
    const program = createProgram();

    await program.parseAsync(['node', 'test', 'build', '--ui', '--jobs', '4', '--brand', 'beta']);

    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'beta');
    expect(buildUI).toHaveBeenCalledWith('/project/engine');
    expect(build).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('Using 4 parallel jobs');
  });

  it('rejects invalid parsed job counts before invoking the command action', async () => {
    const program = createProgram();

    await expect(program.parseAsync(['node', 'test', 'build', '--jobs', '0'])).rejects.toThrow(
      /jobs must be a positive integer/i
    );

    expect(build).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();
  });
});
