// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths, nativePath } from '../../test-utils/index.js';
import { createFsMock, createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(),
  getProjectPaths: vi.fn(),
}));

vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
  // `packageCommand` calls `machPackageCapture` so it can pass the captured
  // stderr through `explainMachError` and surface targeted hints. Tests seed
  // resolved results with the standard `{ stdout, stderr, exitCode }` shape.
  machPackageCapture: vi.fn(),
  withBuildLock: vi.fn((_root: string, body: () => Promise<void>) => body()),
}));

vi.mock('../../core/mach-build-artifacts.js', async (original) => ({
  ...(await original<typeof import('../../core/mach-build-artifacts.js')>()),
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/mybrowser' })
  ),
}));
vi.mock('../../core/marionette-port.js', () => ({ ensureLaunchableBrowserNotRunning: vi.fn() }));

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/logger.js', () => createLoggerMock());

vi.mock('../../core/brand-validation.js', () => ({
  validateBrandOverride: vi.fn(),
}));

vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(),
  assertNoPendingFurnaceRepair: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/build-provenance.js', () => ({ assessBuildProvenance: vi.fn() }));
vi.mock('../../core/furnace-staleness.js', () => ({ listStaleFurnaceComponents: vi.fn() }));

import { validateBrandOverride } from '../../core/brand-validation.js';
import { assertNoPendingFurnaceRepair, prepareBuildEnvironment } from '../../core/build-prepare.js';
import { assessBuildProvenance } from '../../core/build-provenance.js';
import { getProjectPaths, loadConfig } from '../../core/config.js';
import { listStaleFurnaceComponents } from '../../core/furnace-staleness.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  machPackageCapture,
} from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { error, info, outro, verbose, warn } from '../../utils/logger.js';
import { packageCommand } from '../package.js';

describe('packageCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(assessBuildProvenance).mockResolvedValue({});
    vi.mocked(listStaleFurnaceComponents).mockResolvedValue([]);
    vi.mocked(machPackageCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('requires a completed build before packaging', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: false, objDir: 'obj-debug' });

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Packaging requires a completed build.'
    );

    expect(machPackageCapture).not.toHaveBeenCalled();
  });

  it('fails before packaging when the engine checkout is missing', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Firefox source not found. Run "fireforge download" first.'
    );

    expect(machPackageCapture).not.toHaveBeenCalled();
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

    expect(machPackageCapture).not.toHaveBeenCalled();
  });

  it('rejects copied or relocated build artifacts before invoking mach', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: true,
      objDir: 'obj-debug',
      metadataMismatch: { objDir: 'obj-debug', topsrcdir: '/other/workspace/engine' },
    });

    await expect(packageCommand('/project', {})).rejects.toThrow(
      /copied or relocated build artifacts/i
    );

    expect(machPackageCapture).not.toHaveBeenCalled();
  });

  it('wraps package startup failures with build context', async () => {
    vi.mocked(machPackageCapture).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(packageCommand('/project', {})).rejects.toThrow('Package process failed to start');
  });

  it('packages a build that matches the tree, without writing to the engine first', async () => {
    await expect(packageCommand('/project', { brand: 'stable' })).resolves.toBeUndefined();

    // Branding, a Furnace apply or a new mozconfig here would put engine files
    // the dist does not contain into the tree the package claims to come from.
    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'stable');
    expect(verbose).toHaveBeenCalledWith('Packaging with brand: stable');
    expect(info).toHaveBeenCalledWith('Brand: stable');
    expect(machPackageCapture).toHaveBeenCalledWith(nativePath('/project/engine'));
    expect(info).toHaveBeenCalledWith('\nPackage created in obj-*/dist/');
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('Packaging completed in'));
  });

  describe("a build that is not the tree's", () => {
    it('never ships a binary that still carries a negative control, whatever the flags', async () => {
      vi.mocked(assessBuildProvenance).mockResolvedValue({ controlBuilt: 'carries c.diff' });
      for (const options of [{}, { allowStaleBuild: true }]) {
        await expect(packageCommand('/project', options)).rejects.toThrow(/carries c\.diff/);
      }
      expect(machPackageCapture).not.toHaveBeenCalled();
    });

    it.each([
      ['no recorded build', { noBaseline: 'No build is recorded.' }, [], /No build is recorded/],
      ['a tree past the build', { stale: ['gfx/a.cpp is newer.'] }, [], /gfx\/a\.cpp is newer/],
      ['undeployed Furnace edits', {}, ['moz-x'], /undeployed edits.*moz-x/],
    ])(
      'refuses %s, and --allow-stale-build ships it with a warning',
      async (_label, found, pending, message) => {
        vi.mocked(assessBuildProvenance).mockResolvedValue(found);
        vi.mocked(listStaleFurnaceComponents).mockResolvedValue(pending);
        await expect(packageCommand('/project', {})).rejects.toThrow(message);
        expect(machPackageCapture).not.toHaveBeenCalled();
        await packageCommand('/project', { allowStaleBuild: true });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(message));
        expect(machPackageCapture).toHaveBeenCalledOnce();
      }
    );

    it('stops on an unresolved Furnace repair marker', async () => {
      vi.mocked(assertNoPendingFurnaceRepair).mockRejectedValueOnce(new Error('repair marker'));
      await expect(packageCommand('/project', { allowStaleBuild: true })).rejects.toThrow(
        'repair marker'
      );
      expect(machPackageCapture).not.toHaveBeenCalled();
    });
  });

  it('treats non-zero package exits as build failures', async () => {
    vi.mocked(machPackageCapture).mockResolvedValue({ stdout: '', stderr: '', exitCode: 1 });

    await expect(packageCommand('/project', {})).rejects.toThrow(
      'Packaging failed with exit code 1'
    );

    expect(error).toHaveBeenCalledWith(expect.stringContaining('Packaging failed after'));
  });

  it('surfaces the packager NoneType hint on a matching failure', async () => {
    // `mach package` can trip an `AttributeError: 'NoneType' object has no
    // attribute 'open'` inside packager.py, which surfaces as a generic
    // `Packaging failed`. With `explainMachError` wired into the package
    // error path, the hint lands in the thrown message so the operator sees
    // the "run a full build first" recovery without cross-referencing the
    // traceback.
    vi.mocked(machPackageCapture).mockResolvedValue({
      stdout: '',
      stderr: [
        'Traceback (most recent call last):',
        '  File "/engine/python/mozbuild/mozpack/packager.py", line 241, in package_fastload',
        '    zip = self.target.open(path, "wb")',
        "AttributeError: 'NoneType' object has no attribute 'open'",
      ].join('\n'),
      exitCode: 1,
    });

    await expect(packageCommand('/project', {})).rejects.toThrow(/NoneType\.open.*packager\.py/);
  });
});
