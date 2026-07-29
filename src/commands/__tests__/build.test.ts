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
  hasRunnableBundle: vi.fn(),
  buildArtifactMismatchMessage: vi.fn(),
  attemptMozinfoRewrite: vi.fn(),
  runMach: vi.fn(),
  // Build lock added in 0.16.0; the tests below exercise buildCommand
  // which wraps build/buildUI in `withBuildLock`. A pass-through stub
  // keeps focus on the command-level behaviour — dedicated lock tests
  // live in `src/core/__tests__/build-lock.integration.test.ts`.
  withBuildLock: vi.fn((_projectRoot: string, operation: () => Promise<unknown>) => operation()),
}));

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  checkDiskSpace: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../utils/logger.js', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    stop: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
  })),
}));

vi.mock('../../core/brand-validation.js', () => ({
  validateBrandOverride: vi.fn(),
}));

vi.mock('../../core/build-prepare.js', async (importOriginal) => ({
  // Keep the real describeSignalShapedExit so exit-code diagnostics stay
  // authentic; only the environment mutation is stubbed.
  ...(await importOriginal<typeof import('../../core/build-prepare.js')>()),
  prepareBuildEnvironment: vi.fn(),
}));

vi.mock('../../core/build-baseline.js', () => ({
  readBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
  writeBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('../../core/build-audit.js', () => ({
  auditBuildArtifacts: vi.fn(() =>
    Promise.resolve({ updated: 0, stale: 0, missing: 0, skipped: 0, entries: [] })
  ),
}));

// The probe itself is covered by src/core/__tests__/toolchain-preflight.test.ts;
// here it defaults to "no mismatch" so every existing command test proceeds,
// and the dedicated preflight tests below override per-case. The message
// formatter stays real so the fail-fast assertion pins the actual wording.
vi.mock('../../core/toolchain-preflight.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/toolchain-preflight.js')>();
  return {
    ...actual,
    runToolchainPreflight: vi.fn(() => Promise.resolve([])),
  };
});

import { validateBrandOverride } from '../../core/brand-validation.js';
import { writeBuildBaseline } from '../../core/build-baseline.js';
import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import { getProjectPaths, loadConfig } from '../../core/config.js';
import {
  attemptMozinfoRewrite,
  build,
  buildArtifactMismatchMessage,
  buildUI,
  hasBuildArtifacts,
  hasRunnableBundle,
  runMach,
} from '../../core/mach.js';
import { runToolchainPreflight } from '../../core/toolchain-preflight.js';
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
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: true,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(prepareBuildEnvironment).mockResolvedValue({
      furnaceApplied: 0,
      reconfigured: false,
    });
    vi.mocked(build).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', attempts: 1 });
    vi.mocked(buildUI).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', attempts: 1 });
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

  it('rewrites mozinfo and reconfigures when --rewrite-mozinfo succeeds', async () => {
    // Safe-relocation path: the mozinfo rewriter patches paths in place
    // and mach configure regenerates the backend. The build proceeds past
    // the preflight rather than aborting with a clean-rebuild instruction,
    // preserving the obj-* tree.
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Build cannot use copied or relocated build artifacts.'
    );
    vi.mocked(attemptMozinfoRewrite).mockResolvedValue({
      rewritten: true,
      newTopsrcdir: '/project/engine',
      newTopobjdir: '/project/engine/obj-debug',
    });
    vi.mocked(runMach).mockResolvedValue(0);

    await expect(buildCommand('/project', { rewriteMozinfo: true })).resolves.toBeUndefined();

    expect(attemptMozinfoRewrite).toHaveBeenCalledWith('/project/engine', 'obj-debug');
    expect(runMach).toHaveBeenCalledWith(['configure'], '/project/engine');
    expect(prepareBuildEnvironment).toHaveBeenCalled();
    expect(build).toHaveBeenCalled();
  });

  it('aborts with the rewriter refusal reason when --rewrite-mozinfo cannot prove safety', async () => {
    // Unsafe-relocation case: rewriter refuses because the objdir name
    // changed. The original mismatch guidance is preserved and the
    // refusal reason is appended so the operator sees both.
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Build cannot use copied or relocated build artifacts.'
    );
    vi.mocked(attemptMozinfoRewrite).mockResolvedValue({
      rewritten: false,
      reason: 'mozinfo objdir "obj-arm64" does not match detected objdir "obj-debug"',
    });

    await expect(buildCommand('/project', { rewriteMozinfo: true })).rejects.toThrow(
      /mozinfo rewrite refused: mozinfo objdir "obj-arm64"/
    );

    expect(runMach).not.toHaveBeenCalled();
    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('surfaces a non-zero mach configure exit after a successful rewrite', async () => {
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(
      'Build cannot use copied or relocated build artifacts.'
    );
    vi.mocked(attemptMozinfoRewrite).mockResolvedValue({
      rewritten: true,
      newTopsrcdir: '/project/engine',
      newTopobjdir: '/project/engine/obj-debug',
    });
    vi.mocked(runMach).mockResolvedValue(2);

    await expect(buildCommand('/project', { rewriteMozinfo: true })).rejects.toThrow(
      /mach configure exited non-zero \(2\) after mozinfo rewrite/
    );

    expect(build).not.toHaveBeenCalled();
  });

  it('runs UI-only builds through buildUI after the shared preflight completes', async () => {
    await expect(buildCommand('/project', { ui: true, brand: 'beta' })).resolves.toBeUndefined();

    expect(validateBrandOverride).toHaveBeenCalledWith('mybrowser', 'beta');
    expect(prepareBuildEnvironment).toHaveBeenCalledWith(
      '/project',
      makeProjectPaths(),
      expect.objectContaining({ binaryName: 'mybrowser' }),
      expect.objectContaining({ previousBaseline: undefined })
    );
    expect(buildUI).toHaveBeenCalledWith('/project/engine');
    expect(build).not.toHaveBeenCalled();
    expect(verbose).toHaveBeenCalledWith('Building with brand: beta');
    expect(info).toHaveBeenCalledWith('Brand: beta');
    expect(outro).toHaveBeenCalledWith(expect.stringContaining('Build completed in'));
  });

  it('records a full-coverage baseline after a successful build (full and --ui alike)', async () => {
    // 0.37.0 item 3: `fireforge build` packages the full test set, so the
    // baseline claims full packaging coverage for the --allow-stale-build
    // coverage gate.
    await expect(buildCommand('/project', {})).resolves.toBeUndefined();
    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      'full',
      undefined,
      'fireforge build'
    );

    vi.mocked(writeBuildBaseline).mockClear();
    await expect(buildCommand('/project', { ui: true })).resolves.toBeUndefined();
    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      'full',
      undefined,
      'fireforge build --ui'
    );
  });

  it('refuses UI-only builds when the launchable bundle is missing', async () => {
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: false,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });

    await expect(buildCommand('/project', { ui: true })).rejects.toThrow(
      /UI-only builds require a completed full build first/
    );

    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it('uses build.jobs from config when the CLI does not override it', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      build: { jobs: 12 },
    } as never);

    await expect(buildCommand('/project', {})).resolves.toBeUndefined();

    expect(build).toHaveBeenCalledWith('/project/engine', 12);
    expect(info).toHaveBeenCalledWith('Using 12 parallel jobs');
  });

  it('prefers the CLI jobs value over build.jobs from config', async () => {
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
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
    vi.mocked(build).mockResolvedValue({
      exitCode: 2,
      attempts: 1,
      stdout: 'make[4]: *** [tools] Error 1\nmake: *** [build] Error 2\n',
      stderr:
        'cp: /project/engine/browser/branding/hominis/Assets.car: No such file or directory\n',
    });

    const failure = await buildCommand('/project', { jobs: 8 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Build failed with exit code 2');
    expect((failure as Error).message).toContain('Mach phase: mach build');
    expect((failure as Error).message).toContain('Last make error: make[4]: *** [tools] Error 1');
    expect((failure as Error).message).toContain('Recent make context:');
    expect((failure as Error).message).toContain(
      'Final failing command/error line: cp: /project/engine/browser/branding/hominis/Assets.car: No such file or directory'
    );
    expect((failure as Error).message).toContain('Captured stderr tail:');
    expect((failure as Error).message).toContain('Assets.car: No such file or directory');
    expect((failure as Error).message).toContain(
      'Verbose rerun: cd /project/engine && ./mach build -v'
    );

    expect(build).toHaveBeenCalledWith('/project/engine', 8);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Build failed after'));
  });

  it('labels signal-shaped exit codes as external interruptions (FORGE F16)', async () => {
    vi.mocked(build).mockResolvedValue({
      exitCode: 144,
      attempts: 1,
      stdout: 'checking for the target C compiler...',
      stderr: '',
    });

    const failure = await buildCommand('/project', {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('Build failed with exit code 144');
    expect((failure as Error).message).toContain('Exit 144 is signal-shaped (144 - 128 = 16');
    expect((failure as Error).message).toContain('interrupted externally');
  });

  it('does not add the signal-shaped note to regular failures (FORGE F16)', async () => {
    vi.mocked(build).mockResolvedValue({
      exitCode: 2,
      attempts: 1,
      stdout: '',
      stderr: 'error: something normal\n',
    });

    const failure = await buildCommand('/project', {}).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('signal-shaped');
  });

  it('prioritizes real make failures over trailing Python warning noise', async () => {
    vi.mocked(build).mockResolvedValue({
      exitCode: 2,
      attempts: 1,
      stdout: [
        '35:12.42 gmake[4]: Entering directory `/project/engine/obj-debug/browser/app/tools`',
        '35:12.43 /usr/bin/python3 /project/engine/browser/app/tools/repackage.py',
        '35:12.44 cp: /project/engine/browser/branding/hominis/Assets.car: No such file or directory',
        '35:12.45 gmake[4]: *** [browser/app/tools/target] Error 1',
        '35:12.46 gmake[3]: *** [browser/app/tools] Error 2',
        '35:12.47 gmake[2]: *** [default] Error 2',
        '/opt/homebrew/lib/python3.11/site-packages/urllib3/__init__.py:35: NotOpenSSLWarning: urllib3 v2 only supports OpenSSL 1.1.1+; currently the ssl module is compiled with LibreSSL',
      ].join('\n'),
      stderr: '',
    });

    const failure = await buildCommand('/project', { jobs: 8 }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain(
      'Last make error: 35:12.46 gmake[3]: *** [browser/app/tools] Error 2'
    );
    expect(message).toContain('Recent make context:');
    expect(message).toContain('gmake[4]: *** [browser/app/tools/target] Error 1');
    expect(message).toContain(
      'Final failing command/error line: 35:12.44 cp: /project/engine/browser/branding/hominis/Assets.car: No such file or directory'
    );
    expect(message).not.toContain('Final failing command/error line: /opt/homebrew');
  });

  it('annotates a successful build whose captured output warns about a stale config.status', async () => {
    // Eval finding (E1-#2, E2): mach prints "config.status is out of
    // date … Be sure to run |mach build|" at the tail of a successful
    // build when tool-managed branding edits landed on moz.configure
    // before the build. Operators read that as "build is incomplete"
    // and either rebuilt unnecessarily or doubted the Fireforge footer.
    const staleStdout = [
      'Your build was successful!',
      'config.status is out of date with respect to browser/moz.configure',
      'Configure complete!',
      'Be sure to run |mach build| to pick up any changes',
    ].join('\n');
    vi.mocked(build).mockResolvedValue({
      exitCode: 0,
      stdout: staleStdout,
      stderr: '',
      attempts: 1,
    });

    await expect(buildCommand('/project', { jobs: 4 })).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('tool-managed branding edits applied before the build')
    );
  });

  it('annotates a successful build whose tail is mach\'s "Config object not found" banner (Finding 8)', async () => {
    // 2026-04-26 eval Finding 8: a successful build can end with
    // mach's "Config object not found by mach. / Configure complete! /
    // Be sure to run |mach build|" banner without the
    // "config.status is out of date" line that the 0.18.0 fix keyed
    // on. Operators on this path saw the contradictory tail
    // unannotated. Both shapes now route through the same info
    // banner so the explanation always appears before FireForge's
    // own outro.
    const staleStdout = [
      'Your build was successful!',
      'Config object not found by mach.',
      'Configure complete!',
      'Be sure to run |mach build| to pick up any changes',
    ].join('\n');
    vi.mocked(build).mockResolvedValue({
      exitCode: 0,
      stdout: staleStdout,
      stderr: '',
      attempts: 1,
    });

    await expect(buildCommand('/project', { jobs: 4 })).resolves.toBeUndefined();

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('tool-managed branding edits applied before the build')
    );
  });

  it('emits the configure-banner annotation BEFORE the FireForge "Build completed" outro (Finding 8)', async () => {
    // The pre-fix order on the merged tail read:
    //   [mach's confusing banner] / [FireForge's "Build completed" outro]
    // with the explanation either missing (Finding 8 second shape) or
    // landing in a less prominent spot. The fix guarantees that when
    // the annotation fires it lands BEFORE the outro so the operator's
    // very last terminal line is the explanation, not the unannotated
    // confusing tail. Asserts the recorded mock-call order: the info
    // call must precede the outro call.
    const staleStdout = [
      'Your build was successful!',
      'Config object not found by mach.',
      'Configure complete!',
    ].join('\n');
    vi.mocked(build).mockResolvedValue({
      exitCode: 0,
      stdout: staleStdout,
      stderr: '',
      attempts: 1,
    });

    await expect(buildCommand('/project', { jobs: 4 })).resolves.toBeUndefined();

    const infoIdx = vi
      .mocked(info)
      .mock.calls.findIndex((c) =>
        c[0].includes('tool-managed branding edits applied before the build')
      );
    const outroIdx = vi.mocked(outro).mock.calls.findIndex((c) => c[0].includes('Build completed'));
    expect(infoIdx).toBeGreaterThanOrEqual(0);
    expect(outroIdx).toBeGreaterThanOrEqual(0);
    const infoOrder = vi.mocked(info).mock.invocationCallOrder[infoIdx];
    const outroOrder = vi.mocked(outro).mock.invocationCallOrder[outroIdx];
    if (infoOrder === undefined || outroOrder === undefined) {
      throw new Error('expected both invocationCallOrder entries to be populated');
    }
    expect(infoOrder).toBeLessThan(outroOrder);
  });

  it('wraps startup failures before mach returns an exit code', async () => {
    vi.mocked(build).mockRejectedValue(new Error('spawn ENOENT'));

    await expect(buildCommand('/project', { jobs: 4 })).rejects.toThrow(
      'Build process failed to start'
    );

    expect(error).not.toHaveBeenCalled();
  });

  it('halts before mach build when Furnace apply fails during preflight', async () => {
    // Pins the user-facing guarantee in the v0.11.0 CHANGELOG: "fireforge
    // build now halts when Furnace apply fails instead of warning and
    // continuing to mach build." Building a browser that silently dropped
    // requested component changes is worse than failing early, so a
    // regression here would be a real correctness bug even though the
    // underlying prepareBuildEnvironment unit tests still pass.
    const { FurnaceError } = await import('../../errors/furnace.js');
    vi.mocked(prepareBuildEnvironment).mockRejectedValue(
      new FurnaceError('2 components failed to apply cleanly')
    );

    await expect(buildCommand('/project', {})).rejects.toThrow(
      '2 components failed to apply cleanly'
    );

    // mach must never run. Neither the headless build nor the UI-only
    // fast path is allowed to continue past a furnace apply failure.
    expect(build).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();

    // The success banner must not have been emitted either — a user
    // reading only the trailing output should not see "Build completed".
    expect(outro).not.toHaveBeenCalled();
  });

  it('fails fast naming fireforge bootstrap when the toolchain preflight reports a mismatch', async () => {
    // 152.0b7 → 153.0b8 source-refresh drill: the post-hop build died
    // ~8s into mach configure on a moved cbindgen minimum. The preflight
    // must abort BEFORE any expensive pre-build work (Furnace apply,
    // mozconfig, mach), with `fireforge bootstrap` as the named remedy.
    vi.mocked(runToolchainPreflight).mockResolvedValueOnce([
      {
        tool: 'cbindgen',
        minimumVersion: '0.29.4',
        declaredIn: 'build/moz.configure/bindgen.configure',
        candidates: [{ binary: 'cbindgen', version: '0.29.1' }],
      },
    ]);

    await expect(buildCommand('/project', {})).rejects.toThrow(/fireforge bootstrap/);

    expect(prepareBuildEnvironment).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
    expect(buildUI).not.toHaveBeenCalled();
  });

  it('proceeds to the build when the toolchain preflight passes (fail-soft default)', async () => {
    await buildCommand('/project', {});

    expect(runToolchainPreflight).toHaveBeenCalledWith('/project/engine');
    expect(build).toHaveBeenCalled();
  });
});

describe('registerBuild', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getProjectPaths).mockReturnValue(makeProjectPaths());
    vi.mocked(loadConfig).mockResolvedValue({
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    } as never);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(hasRunnableBundle).mockResolvedValue({
      runnable: true,
      expectedPath: 'obj-debug/dist/bin/mybrowser',
    });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(prepareBuildEnvironment).mockResolvedValue({
      furnaceApplied: 0,
      reconfigured: false,
    });
    vi.mocked(build).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', attempts: 1 });
    vi.mocked(buildUI).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', attempts: 1 });
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
