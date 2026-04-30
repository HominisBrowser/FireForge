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
  // The run command resolves `config.binaryName` to probe the runnable
  // bundle (Finding #13). Stub a fixed binary name so hasRunnableBundle
  // has a stable probe target.
  loadConfig: vi.fn(() =>
    Promise.resolve({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    })
  ),
}));

vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
  buildArtifactMismatchMessage: vi.fn(() => undefined),
  // Default to "bundle runnable" so pre-existing tests that gate on
  // other preflights still reach `mach run`. The new bundle-agreement
  // tests below override per-case.
  hasRunnableBundle: vi.fn(() =>
    Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/mybrowser' })
  ),
  run: vi.fn(),
  runMachSmoke: vi.fn(),
}));

vi.mock('node:fs', () => ({
  createWriteStream: vi.fn(() => ({ end: vi.fn(), on: vi.fn() })),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
  };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  removeDir: vi.fn(),
  removeFile: vi.fn(),
}));

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

import { createWriteStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';

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
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  hasRunnableBundle,
  run,
  runMachSmoke,
} from '../../core/mach.js';
import { ExitCode } from '../../errors/codes.js';
import { SmokeRunError } from '../../errors/run.js';
import { pathExists, removeDir, removeFile } from '../../utils/fs.js';
import { info, verbose, warn } from '../../utils/logger.js';
import { registerRun, runCommand, SMOKE_EXIT_FAILURE, SMOKE_LAUNCH_FAILURE } from '../run.js';

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
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: true,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });
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

  it('fails with a bundle-specific message when obj-*/dist exists but the binary does not (Finding #13)', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: false,
      expectedPath: 'obj-debug/dist/MyBrowser.app/Contents/MacOS/mybrowser',
    });

    await expect(runCommand('/project')).rejects.toThrow(
      /Run requires a completed build that produced the launchable bundle/
    );
    await expect(runCommand('/project')).rejects.toThrow(
      /obj-debug\/dist\/MyBrowser\.app\/Contents\/MacOS\/mybrowser is missing/
    );
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

  // --- smoke-exit coverage ---

  describe('--smoke-exit', () => {
    it('routes through runMachSmoke and succeeds when the deadline fires with no findings', async () => {
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 143,
        timedOut: true,
      });

      await expect(runCommand('/project', { smokeExit: 30 })).resolves.toBeUndefined();

      expect(run).not.toHaveBeenCalled();
      expect(runMachSmoke).toHaveBeenCalledWith(
        ['run'],
        '/project/engine',
        expect.objectContaining({ smokeTimeoutMs: 30_000 })
      );
    });

    it('fails with SMOKE_EXIT_FAILURE when an unallowed error line fires', async () => {
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStderrLine?.('JavaScript error: lazy.MyBrowserEvents.MYBROWSER_TOPICS is undefined');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      const thrown = await runCommand('/project', { smokeExit: 30 }).catch(
        (error: unknown) => error
      );
      expect(thrown).toBeInstanceOf(SmokeRunError);
      expect((thrown as SmokeRunError).code).toBe(SMOKE_EXIT_FAILURE);
      expect((thrown as SmokeRunError).code).toBe(ExitCode.SMOKE_EXIT_FAILURE);
    });

    it('ignores error lines that match any --console-allow regex', async () => {
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStderrLine?.('JavaScript error: known-flake 404');
        opts.onStderrLine?.('JavaScript error: real failure');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      // Only the 'real failure' line should count — it's not in the allowlist.
      const thrown = await runCommand('/project', {
        smokeExit: 30,
        consoleAllow: ['known-flake'],
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(SmokeRunError);
      expect((thrown as SmokeRunError).code).toBe(SMOKE_EXIT_FAILURE);
    });

    it('succeeds when every error line matches the allowlist', async () => {
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStderrLine?.('JavaScript error: known-flake 404');
        opts.onStderrLine?.('console.error: AsyncShutdown drained');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      await expect(
        runCommand('/project', {
          smokeExit: 30,
          consoleAllow: ['known-flake', 'AsyncShutdown'],
        })
      ).resolves.toBeUndefined();
    });

    it('reports non-error allowlist matches in the "total allowlisted lines" counter', async () => {
      // Finding #15: pre-0.16.0, `--console-allow RSLoader:` matching a
      // `console.warn: RSLoader:...` line still reported 0 hits because
      // the allowlist was only consulted AFTER `matchesSmokeError`. The
      // summary now distinguishes suppressed errors from total allowlist
      // matches, so the operator sees both numbers and can tell whether
      // the allowlist pattern actually matched anything.
      const infoCalls: string[] = [];
      vi.mocked(info).mockImplementation((msg: string) => {
        infoCalls.push(msg);
      });
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStdoutLine?.('console.warn: RSLoader: warmup-only');
        opts.onStderrLine?.('[WARN  webrender::device::gl] shader missing');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      await expect(
        runCommand('/project', {
          smokeExit: 30,
          consoleAllow: ['RSLoader:', 'webrender::device::gl'],
        })
      ).resolves.toBeUndefined();

      expect(infoCalls).toContain('  Allowlisted error hits (suppressed): 0');
      expect(infoCalls).toContain('  Allowlisted lines total: 2');
    });

    it('fails with SMOKE_LAUNCH_FAILURE when the child exits non-cleanly before the deadline', async () => {
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 1,
        timedOut: false,
      });

      const thrown = await runCommand('/project', { smokeExit: 30 }).catch(
        (error: unknown) => error
      );
      expect(thrown).toBeInstanceOf(SmokeRunError);
      expect((thrown as SmokeRunError).code).toBe(SMOKE_LAUNCH_FAILURE);
    });

    it('rejects a zero or negative smokeExit explicitly', async () => {
      await expect(runCommand('/project', { smokeExit: 0 })).rejects.toThrow(/positive integer/i);
      expect(runMachSmoke).not.toHaveBeenCalled();
    });

    it('does not invoke runMachSmoke when --smoke-exit is not set', async () => {
      vi.mocked(run).mockResolvedValue(0);

      await expect(runCommand('/project')).resolves.toBeUndefined();

      expect(runMachSmoke).not.toHaveBeenCalled();
      expect(run).toHaveBeenCalled();
    });

    it('compiles allowlist entries from --console-allow-file and applies them', async () => {
      vi.mocked(readFile).mockResolvedValue('# skip comment\n\nknown-flake\nAsyncShutdown\n');
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStderrLine?.('JavaScript error: known-flake tripped');
        opts.onStderrLine?.('console.error: AsyncShutdown drained');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      await expect(
        runCommand('/project', { smokeExit: 30, consoleAllowFile: '/tmp/allow.txt' })
      ).resolves.toBeUndefined();

      expect(readFile).toHaveBeenCalledWith('/tmp/allow.txt', 'utf8');
    });

    it('wraps --console-allow-file read errors as InvalidArgumentError', async () => {
      const { InvalidArgumentError } = await import('../../errors/base.js');
      vi.mocked(readFile).mockRejectedValue(new Error('ENOENT: no such file'));

      const thrown = await runCommand('/project', {
        smokeExit: 30,
        consoleAllowFile: '/tmp/missing.txt',
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(InvalidArgumentError);
      expect((thrown as Error).message).toMatch(/Failed to read --console-allow-file/);
      expect(runMachSmoke).not.toHaveBeenCalled();
    });

    it('wraps bad --console-allow regex as InvalidArgumentError', async () => {
      const { InvalidArgumentError } = await import('../../errors/base.js');

      const thrown = await runCommand('/project', {
        smokeExit: 30,
        consoleAllow: ['[unterminated'],
      }).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(InvalidArgumentError);
      expect(runMachSmoke).not.toHaveBeenCalled();
    });

    it('opens --capture-console write stream and closes it when the run finishes', async () => {
      const endSpy = vi.fn();
      vi.mocked(createWriteStream).mockReturnValue({
        end: endSpy,
        on: vi.fn(),
      } as unknown as ReturnType<typeof createWriteStream>);
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 143,
        timedOut: true,
      });

      await expect(
        runCommand('/project', { smokeExit: 30, captureConsole: '/tmp/smoke.log' })
      ).resolves.toBeUndefined();

      expect(createWriteStream).toHaveBeenCalledWith('/tmp/smoke.log');
      // .end() fires from the finally block so log rotation after smoke-exit
      // does not race on a still-open writer — essential when agents symlink
      // the capture file to their session log.
      expect(endSpy).toHaveBeenCalledTimes(1);
    });

    it('still closes --capture-console stream when the run throws mid-stream', async () => {
      const endSpy = vi.fn();
      vi.mocked(createWriteStream).mockReturnValue({
        end: endSpy,
        on: vi.fn(),
      } as unknown as ReturnType<typeof createWriteStream>);
      vi.mocked(runMachSmoke).mockRejectedValue(new Error('mach spawn failed'));

      await expect(
        runCommand('/project', { smokeExit: 30, captureConsole: '/tmp/smoke.log' })
      ).rejects.toThrow('mach spawn failed');
      expect(endSpy).toHaveBeenCalledTimes(1);
    });

    it('emits a "…and N more" summary tail when unallowed findings exceed the preview cap', async () => {
      const { info, warn } = await import('../../utils/logger.js');
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        // 12 errors: SMOKE_UNALLOWED_PREVIEW_MAX is 10, so we expect
        // "…and 2 more." plus the ten preview lines.
        for (let i = 0; i < 12; i += 1) {
          opts.onStderrLine?.(`JavaScript error: batch-${String(i)}`);
        }
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      const thrown = await runCommand('/project', { smokeExit: 30 }).catch(
        (error: unknown) => error
      );
      expect(thrown).toBeInstanceOf(SmokeRunError);

      const warnCalls = vi.mocked(warn).mock.calls.flat();
      expect(warnCalls.some((msg) => /…and 2 more/.test(msg))).toBe(true);
      // Sanity: the preview header and the summary info line still fire so
      // the truncation is additive, not a replacement.
      const infoCalls = vi.mocked(info).mock.calls.flat();
      expect(infoCalls.some((msg) => /Smoke run complete/.test(msg))).toBe(true);
    });

    it('hits the cold-start verbose hint when the smoke window is under 30s', async () => {
      const { verbose } = await import('../../utils/logger.js');
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 143,
        timedOut: true,
      });

      await expect(runCommand('/project', { smokeExit: 10 })).resolves.toBeUndefined();

      expect(verbose).toHaveBeenCalledWith(
        expect.stringContaining('cold starts on slow machines often exceed 30s')
      );
    });

    it('routes stdout error lines into findings alongside stderr', async () => {
      vi.mocked(runMachSmoke).mockImplementation((_args, _engine, opts) => {
        opts.onStdoutLine?.('Launching browser…');
        opts.onStdoutLine?.('JavaScript error: in-stdout failure');
        return Promise.resolve({ stdout: '', stderr: '', exitCode: 143, timedOut: true });
      });

      const thrown = await runCommand('/project', { smokeExit: 30 }).catch(
        (error: unknown) => error
      );
      expect(thrown).toBeInstanceOf(SmokeRunError);
      expect((thrown as SmokeRunError).code).toBe(SMOKE_EXIT_FAILURE);
    });
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

    it('parses --smoke-exit as a positive integer and forwards it', async () => {
      const program = new Command();
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 143,
        timedOut: true,
      });

      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      await program.parseAsync(['node', 'fireforge', 'run', '--smoke-exit', '30']);

      expect(runMachSmoke).toHaveBeenCalledWith(
        ['run'],
        '/project/engine',
        expect.objectContaining({ smokeTimeoutMs: 30_000 })
      );
    });

    it('rejects --smoke-exit with a non-integer value at parse time', async () => {
      const program = new Command();
      program.exitOverride(); // Commander normally calls process.exit on parse error.

      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      await expect(
        program.parseAsync(['node', 'fireforge', 'run', '--smoke-exit', 'abc'])
      ).rejects.toThrow(/positive integer/);
      expect(runMachSmoke).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
    });

    it('rejects --smoke-exit with a fractional value', async () => {
      const program = new Command();
      program.exitOverride();

      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      // `parseInt('1.5', 10)` yields `1`, which would silently round a
      // "1.5s smoke window" to 1s. The parser rejects non-integer input
      // explicitly so the operator sees what happened.
      await expect(
        program.parseAsync(['node', 'fireforge', 'run', '--smoke-exit', '1.5'])
      ).rejects.toThrow(/positive integer/);
    });

    it('accumulates repeated --console-allow values and passes them through', async () => {
      const program = new Command();
      vi.mocked(runMachSmoke).mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 143,
        timedOut: true,
      });

      registerRun(program, {
        getProjectRoot: () => '/project',
        withErrorHandling: <T extends unknown[]>(fn: (...args: T) => Promise<void>) => fn,
      });

      await program.parseAsync([
        'node',
        'fireforge',
        'run',
        '--smoke-exit',
        '30',
        '--console-allow',
        'foo',
        '--console-allow',
        'bar',
      ]);

      // The runCommand-level smoke test already proves the allowlist is
      // applied; here we only confirm the Commander parser reached smoke
      // mode with both values (fatal mismatch would make runMachSmoke
      // uncalled when the parser silently drops repeats).
      expect(runMachSmoke).toHaveBeenCalledTimes(1);
    });
  });
});
