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
  warn: vi.fn(),
}));

vi.mock('../../core/furnace-config.js', () => ({
  furnaceConfigExists: vi.fn(),
  loadFurnaceConfig: vi.fn(),
  loadFurnaceState: vi.fn(),
  getFurnacePaths: vi.fn(),
}));

vi.mock('../../core/furnace-apply-helpers.js', () => ({
  extractComponentChecksums: vi.fn(),
  hasComponentChanged: vi.fn(),
}));

import { readdir } from 'node:fs/promises';

import { Command } from 'commander';

import {
  extractComponentChecksums,
  hasComponentChanged,
} from '../../core/furnace-apply-helpers.js';
import {
  furnaceConfigExists,
  getFurnacePaths,
  loadFurnaceConfig,
  loadFurnaceState,
} from '../../core/furnace-config.js';
import { buildArtifactMismatchMessage, hasBuildArtifacts, run } from '../../core/mach.js';
import { pathExists, removeDir, removeFile } from '../../utils/fs.js';
import { verbose, warn } from '../../utils/logger.js';
import { registerRun, runCommand } from '../run.js';

const FURNACE_PATHS = {
  furnaceConfig: '/project/furnace.json',
  componentsDir: '/project/components',
  overridesDir: '/project/furnace/overrides',
  customDir: '/project/furnace/custom',
  furnaceState: '/project/.fireforge/furnace-state.json',
};

describe('runCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(readdir).mockResolvedValue([]);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    // Default: no furnace config so warnIfFurnaceStale returns early
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
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

  // --- warnIfFurnaceStale coverage ---

  it('skips furnace staleness check when furnace config does not exist', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(false);
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(furnaceConfigExists).toHaveBeenCalledWith('/project');
    expect(loadFurnaceConfig).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips furnace staleness check when state has no appliedChecksums', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {},
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({});
    vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(loadFurnaceConfig).toHaveBeenCalled();
    expect(loadFurnaceState).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about stale furnace overrides and custom components', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'my-override': { type: 'full', description: '', basePath: '', baseVersion: '' },
      },
      custom: {
        'my-custom': {
          description: '',
          targetPath: '',
          register: true,
          localized: false,
        },
      },
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: { 'override:my-override': 'abc', 'custom:my-custom': 'def' },
    });
    vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
    vi.mocked(extractComponentChecksums).mockReturnValue({});
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('my-override'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('my-custom'));
    // plural form
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('components'));
  });

  it('warns with singular form when only one component is stale', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'solo-override': { type: 'full', description: '', basePath: '', baseVersion: '' },
      },
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({
      appliedChecksums: { 'override:solo-override': 'abc' },
    });
    vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
    vi.mocked(extractComponentChecksums).mockReturnValue({});
    vi.mocked(hasComponentChanged).mockResolvedValue(true);
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Furnace component modified/));
  });

  it('skips components whose directory does not exist', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        'missing-dir': { type: 'full', description: '', basePath: '', baseVersion: '' },
      },
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({ appliedChecksums: {} });
    vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
    // pathExists returns true for engine dir, but false for the override dir
    vi.mocked(pathExists)
      .mockResolvedValueOnce(true) // engine dir check
      .mockResolvedValueOnce(false); // override component dir check
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(hasComponentChanged).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn when no components have changed', async () => {
    vi.mocked(furnaceConfigExists).mockResolvedValue(true);
    vi.mocked(loadFurnaceConfig).mockResolvedValue({
      version: 1,
      componentPrefix: 'moz-',
      stock: [],
      overrides: {
        unchanged: { type: 'full', description: '', basePath: '', baseVersion: '' },
      },
      custom: {},
    });
    vi.mocked(loadFurnaceState).mockResolvedValue({ appliedChecksums: {} });
    vi.mocked(getFurnacePaths).mockReturnValue(FURNACE_PATHS);
    vi.mocked(extractComponentChecksums).mockReturnValue({});
    vi.mocked(hasComponentChanged).mockResolvedValue(false);
    vi.mocked(run).mockResolvedValue(0);

    await runCommand('/project');

    expect(warn).not.toHaveBeenCalled();
  });

  it('catches furnace staleness errors silently', async () => {
    vi.mocked(furnaceConfigExists).mockRejectedValue(new Error('disk exploded'));
    vi.mocked(run).mockResolvedValue(0);

    await expect(runCommand('/project')).resolves.toBeUndefined();

    expect(verbose).toHaveBeenCalledWith(
      expect.stringContaining('Furnace staleness check skipped due to an error')
    );
    expect(warn).not.toHaveBeenCalled();
  });

  // --- registerRun coverage ---

  describe('registerRun', () => {
    it('registers a "run" command on the program', () => {
      const program = new Command();
      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      const cmd = program.commands.find((c) => c.name() === 'run');
      expect(cmd).toBeDefined();
      expect(cmd?.description()).toBe('Launch the built browser');
    });

    it('invokes runCommand via withErrorHandling when action fires', async () => {
      const program = new Command();
      vi.mocked(run).mockResolvedValue(0);

      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      // Parse "run" to fire the action
      await program.parseAsync(['node', 'fireforge', 'run']);
      expect(run).toHaveBeenCalled();
    });
  });
});
