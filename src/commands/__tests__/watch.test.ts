// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeProjectPaths } from '../../test-utils/index.js';
import { createFsMock } from '../../test-utils/module-mocks.js';

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
  // Watch uses `hasRunnableBundle` informationally (banner suffix only),
  // so default to "runnable" and let the dedicated bundle-state tests
  // override per-case.
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/mybrowser' })
  ),
  watchWithOutput: vi.fn(),
}));

vi.mock('../../utils/fs.js', () => createFsMock());

vi.mock('../../utils/process.js', () => ({
  findExecutable: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('../../utils/logger.js', () => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),
  setStdoutSealed: vi.fn(),

  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  verbose: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: loggerState.spinnerStop,
    error: loggerState.spinnerError,
  })),
}));

// `fireforge watch` now runs a furnace staleness check before entering
// the watch loop. Stub the helper out so the watch tests don't have to
// mock the full furnace-config / apply-helpers dependency graph.
vi.mock('../../core/furnace-staleness.js', () => ({
  warnIfFurnaceStale: vi.fn(() => Promise.resolve()),
}));

import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  buildArtifactMismatchMessage,
  generateMozconfig,
  hasBuildArtifacts,
  hasRunnableBundle,
  watchWithOutput,
} from '../../core/mach.js';
import { pathExists } from '../../utils/fs.js';
import { info, outro } from '../../utils/logger.js';
import { exec, findExecutable } from '../../utils/process.js';
import { watchCommand } from '../watch.js';

describe('watchCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loggerState.spinnerStop.mockReset();
    loggerState.spinnerError.mockReset();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(findExecutable).mockResolvedValue('/opt/homebrew/bin/watchman');
    vi.mocked(exec).mockResolvedValue({
      stdout: '2024.01.15.00\n',
      stderr: '',
      exitCode: 0,
    });
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: true,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });
    vi.mocked(generateMozconfig).mockResolvedValue(undefined);
    vi.mocked(watchWithOutput).mockResolvedValue({ stdout: '', stderr: '', exitCode: 130 });
  });

  it('requires watchman to be installed before starting watch mode', async () => {
    vi.mocked(findExecutable).mockResolvedValue(undefined);

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

  it('adds macOS privacy guidance when mach watch reports a permission failure', async () => {
    vi.mocked(watchWithOutput).mockResolvedValue({
      stdout: '',
      stderr: 'watchman: Operation not permitted while watching /project/engine',
      exitCode: 1,
    });

    await expect(watchCommand('/project')).rejects.toThrow(/Full Disk Access/i);
  });

  it('treats Ctrl+C exits as a normal stop condition', async () => {
    await expect(watchCommand('/project')).resolves.toBeUndefined();

    expect(generateMozconfig).toHaveBeenCalledWith(
      '/project/configs',
      '/project/engine',
      expect.anything()
    );
    // Watch threads a subprocess env into mach so the resolved watchman
    // directory is visible on PATH. Assert the call happened and inspect the
    // env directly rather than via matchers so the types stay concrete for
    // the compiler.
    const call = vi.mocked(watchWithOutput).mock.calls[0];
    expect(call?.[0]).toBe('/project/engine');
    const envPath = call?.[1]?.env?.['PATH'];
    expect(envPath).toBeDefined();
    expect(envPath).toContain('/opt/homebrew/bin');
    expect(outro).toHaveBeenCalledWith('Watch mode stopped');
  });

  // On macOS `which watchman` from an interactive shell returns
  // `/opt/homebrew/bin/watchman`, but the subprocess PATH inherited by
  // `mach watch` frequently omits `/opt/homebrew/bin`. Without forwarding
  // the resolved directory, `mach watch` fails at the `watch-project`
  // subscription step with a `FasterBuildException: timed out`.
  it('forwards the resolved watchman directory to the mach subprocess PATH', async () => {
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '/usr/bin:/bin';
    try {
      vi.mocked(findExecutable).mockResolvedValue('/opt/homebrew/bin/watchman');
      await expect(watchCommand('/project')).resolves.toBeUndefined();

      const call = vi.mocked(watchWithOutput).mock.calls[0];
      expect(call).toBeDefined();
      const passedOptions = call?.[1];
      expect(passedOptions).toBeDefined();
      const passedEnv = passedOptions?.env;
      expect(passedEnv).toBeDefined();
      expect(passedEnv?.['PATH']).toMatch(/^\/opt\/homebrew\/bin/);
      expect(passedEnv?.['PATH']).toContain('/usr/bin');
    } finally {
      if (originalPath !== undefined) {
        process.env['PATH'] = originalPath;
      } else {
        delete process.env['PATH'];
      }
    }
  });

  it('does not duplicate the watchman directory when it is already on PATH', async () => {
    const originalPath = process.env['PATH'];
    process.env['PATH'] = '/opt/homebrew/bin:/usr/bin';
    try {
      vi.mocked(findExecutable).mockResolvedValue('/opt/homebrew/bin/watchman');
      await expect(watchCommand('/project')).resolves.toBeUndefined();

      const call = vi.mocked(watchWithOutput).mock.calls[0];
      const passedPath = call?.[1]?.env?.['PATH'];
      // The helper only prepends when the directory is not already
      // present; it leaves the existing PATH untouched otherwise.
      expect(passedPath).toBe('/opt/homebrew/bin:/usr/bin');
    } finally {
      if (originalPath !== undefined) {
        process.env['PATH'] = originalPath;
      } else {
        delete process.env['PATH'];
      }
    }
  });

  it('refuses to start when watchman is in PATH but does not respond', async () => {
    vi.mocked(exec).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    await expect(watchCommand('/project')).rejects.toThrow(
      /Watchman is installed but did not respond/
    );

    expect(watchWithOutput).not.toHaveBeenCalled();
  });

  it('refuses to start when watchman exits non-zero on a probe call', async () => {
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: '',
      stderr: 'broken install',
      exitCode: 1,
    });

    await expect(watchCommand('/project')).rejects.toThrow(/watchman --version" exited 1/);

    expect(watchWithOutput).not.toHaveBeenCalled();
  });

  it('refuses to start when watchman --version returns no output', async () => {
    vi.mocked(exec).mockResolvedValueOnce({
      stdout: '   \n',
      stderr: '',
      exitCode: 0,
    });

    await expect(watchCommand('/project')).rejects.toThrow(/produced no output/);

    expect(watchWithOutput).not.toHaveBeenCalled();
  });

  it('appends `(bundle: runnable)` when the executable is already built', async () => {
    await watchCommand('/project');

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Using build artifacts from obj-debug/ (bundle: runnable)')
    );
  });

  it('appends `(bundle: pending — watch will rebuild)` when the binary is missing', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: false,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });

    await watchCommand('/project');

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Using build artifacts from obj-debug/ (bundle: pending — watch will rebuild)'
      )
    );
    // Watch must still start even when the bundle isn't runnable yet —
    // that's exactly the case watch exists for.
    expect(watchWithOutput).toHaveBeenCalled();
  });
});
