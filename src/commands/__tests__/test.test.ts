// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
    })
  ),
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

vi.mock('../../core/mach.js', () => {
  // One shared dispatch mock backs all three capture entry points. The
  // default classification (findNearestXpcshellManifest → null) routes runs
  // to `mochitestWithOutput`; aliasing it (and the xpcshell variant) to the
  // same fn as `testWithOutput` keeps every existing assertion valid no
  // matter which suite a test's paths classify as. The dedicated E1 dispatch
  // test uses its own module mock with distinct fns.
  const captureDispatch = vi.fn();
  return {
    hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
    // Default to "launchable bundle present" so existing tests keep passing
    // through the new runnable-bundle preflight added for finding 17. The
    // dedicated regression test for the missing-binary branch overrides
    // this with mockResolvedValueOnce({ runnable: false, ... }).
    hasRunnableBundle: vi.fn(() =>
      Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/firefox' })
    ),
    buildArtifactMismatchMessage: vi.fn(() => undefined),
    runProtectedMachBuild: vi.fn(),
    testWithOutput: captureDispatch,
    xpcshellTestWithOutput: captureDispatch,
    mochitestWithOutput: captureDispatch,
    withBuildLock: vi.fn((_projectRoot: string, operation: () => Promise<unknown>) => operation()),
  };
});

vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(() =>
    Promise.resolve({ furnaceApplied: 0, reconfigured: false, fullBuildRequired: false })
  ),
}));

vi.mock('../../core/build-baseline.js', () => ({
  readBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
  writeBuildBaseline: vi.fn(() => Promise.resolve()),
}));

// The --extend-coverage anchor probes real git/file state (covered by
// src/core/__tests__/coverage-extend.test.ts); here the command-level
// contract is what the command does with each verdict, so the probes are
// mocked and the union stays real.
vi.mock('../../core/coverage-extend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/coverage-extend.js')>();
  return {
    ...actual,
    checkExtendCoverageAnchor: vi.fn(() => Promise.resolve({ ok: true })),
    checkExtendMozconfigAnchor: vi.fn(() => Promise.resolve({ ok: true })),
  };
});

// Default to the pass-through analysis (file args, no siblings) so every
// existing dispatch assertion stays valid; the directory-scope tests
// override per case. formatScopeNotice stays real so notice assertions
// pin the actual wording. The fs-walking analysis itself is covered by
// src/core/__tests__/test-path-scope.test.ts.
vi.mock('../../core/test-path-scope.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/test-path-scope.js')>();
  return {
    ...actual,
    analyzeTestPathScopes: vi.fn((_engineDir: string, paths: readonly string[]) =>
      Promise.resolve(
        paths.map((p) => ({
          requestedPath: p,
          dispatchPaths: [p],
          isDirectory: false,
          testFileCount: 0,
          siblingPrefixMatches: [],
        }))
      )
    ),
  };
});

vi.mock('../../utils/fs.js', () => ({
  pathExists: vi.fn(),
  isSymlink: vi.fn(() => Promise.resolve(false)),
  removeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/logger.js', () => ({
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  info: vi.fn(),
  note: vi.fn(),
  outro: vi.fn(),
  success: vi.fn(),
  verbose: vi.fn(),
  warn: vi.fn(),
  spinner: vi.fn(() => ({
    message: vi.fn(),
    stop: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../utils/platform.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/platform.js')>()),
  // Pin the platform so the headed no-output-timeout hint (darwin-only,
  // FORGE F17) is deterministic regardless of the CI host.
  getPlatform: vi.fn(() => 'darwin'),
}));

vi.mock('../../core/marionette-preflight.js', () => ({
  runMarionettePreflight: vi.fn(),
  reportMarionettePreflight: vi.fn(),
  formatMarionettePreflightLine: (result: { ok: boolean; durationMs: number; detail: string }) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    return `Marionette preflight: ${status} (${result.durationMs}ms) — ${result.detail}`;
  },
}));

// Default to "port is free" so every existing test case proceeds
// through the probe to the mach invocation. The dedicated port-probe
// tests in `src/core/__tests__/marionette-port.test.ts` exercise the
// holder detection and error shape in isolation.
vi.mock('../../core/marionette-port.js', async () => {
  // Use the real `extractForwardedMarionettePort` and
  // `shouldAutoForwardMarionettePortToMach` helpers — they are pure parsing
  // utilities and exercising them through
  // the test command keeps the integration honest. Mock only the I/O-shaped
  // probe so the mach invocation is reached.
  const actual = await vi.importActual<typeof import('../../core/marionette-port.js')>(
    '../../core/marionette-port.js'
  );
  return {
    ...actual,
    assertMarionettePortAvailable: vi.fn(() => Promise.resolve()),
    ensureLaunchableBrowserNotRunning: vi.fn(() => Promise.resolve()),
    ensureMarionettePortAvailable: vi.fn(() => Promise.resolve()),
    probeMarionettePort: vi.fn(() => Promise.resolve({ inUse: false })),
  };
});

// Partial mock: the probes and warning copy stay stubbed, but the pure
// coverage helpers (`findUncoveredRequestPaths`, `formatTestCoverageRefusal`,
// `formatStaticComponentsRefusal`) run real so the refusal tests pin the
// actual matcher semantics and message wording through the command.
vi.mock('../../core/test-stale-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/test-stale-check.js')>();
  return {
    ...actual,
    checkStaleBuildForTest: vi.fn(() =>
      Promise.resolve({ stale: false, changedPaths: [], truncated: 0, baseline: undefined })
    ),
    checkStaticComponentsStale: vi.fn(() =>
      Promise.resolve({ stale: false, changedManifests: [] })
    ),
    formatStaleBuildWarning: vi.fn(() => 'stale warning'),
  };
});

vi.mock('../../core/xpcshell-appdir.js', () => ({
  findNearestXpcshellManifest: vi.fn(() => Promise.resolve(null)),
  resolveXpcshellAppdirArg: vi.fn(() => Promise.resolve({ kind: 'none' })),
  operatorAlreadySetAppPath: vi.fn(() => false),
}));

// The in-tree objdir/marker cross-check is a pass-through by default; the
// dedicated test drives its refusal. Real behavior is covered in
// tree-store.integration.test.ts.
vi.mock('../../core/tree-store.js', () => ({
  assertObjdirMatchesTreeMarker: vi.fn(() => Promise.resolve()),
}));

import { readBuildBaseline, writeBuildBaseline } from '../../core/build-baseline.js';
import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import { loadConfig } from '../../core/config.js';
import {
  checkExtendCoverageAnchor,
  checkExtendMozconfigAnchor,
} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  runProtectedMachBuild,
  testWithOutput,
  withBuildLock,
  xpcshellTestWithOutput,
} from '../../core/mach.js';
import {
  assertMarionettePortAvailable,
  ensureLaunchableBrowserNotRunning,
  ensureMarionettePortAvailable,
} from '../../core/marionette-port.js';
import {
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../../core/marionette-preflight.js';
import { analyzeTestPathScopes } from '../../core/test-path-scope.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  formatStaleBuildWarning,
} from '../../core/test-stale-check.js';
import { assertObjdirMatchesTreeMarker } from '../../core/tree-store.js';
import {
  findNearestXpcshellManifest,
  operatorAlreadySetAppPath,
  resolveXpcshellAppdirArg,
} from '../../core/xpcshell-appdir.js';
import { GeneralError } from '../../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../../errors/build.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { info, note, outro, success, warn } from '../../utils/logger.js';
import { testCommand } from '../test.js';

describe('testCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
    vi.mocked(isSymlink).mockResolvedValue(false);
    vi.mocked(removeFile).mockResolvedValue();
  });

  it('fails before invoking mach when a requested test path does not exist', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/missing.js'])
    ).rejects.toThrow(/run "fireforge import" first/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('surfaces UNKNOWN TEST as a discovery error instead of a generic build failure', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'UNKNOWN TEST: browser/modules/mybrowser/test/browser_mybrowser_schema.js',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_schema.js'])
    ).rejects.toThrow(/could not discover the requested test path/i);
  });

  it('surfaces harness startup failures before reporting a generic test failure', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        'INFO Running browser-chrome tests\n' +
        'HominisBrowserUnavailableError: browser process exited before Marionette session startup',
      stderr: 'WARNING unrelated teardown noise',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).rejects.toThrow(/mach test did not run the selected tests/i);
    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).rejects.toThrow(/HominisBrowserUnavailableError/i);
  });

  it('surfaces zero selected tests run as a harness/discovery failure', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'SUITE-START | Running 0 tests\nRan 0 tests and 0 subtests',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).rejects.toThrow(/zero selected tests ran/i);
  });

  it('keeps ordinary nonzero mach test failures on the generic BuildError path', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).rejects.toBeInstanceOf(BuildError);
  });

  it('summarizes the first focused test failure after a successful --build rebuild', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        'INFO Running browser-chrome tests\n' +
        'TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false',
      stderr: '',
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        build: true,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BuildError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('Post-rebuild test failure:');
    expect(message).toContain('Rebuild command: fireforge test --build');
    expect(message).toContain('Requested paths: browser/base/content/test/dummy/browser_dummy.js');
    expect(message).toContain(
      'First post-rebuild failure: TEST-UNEXPECTED-FAIL | browser_dummy.js | expected true got false'
    );
  });

  it('rewrites stale-branding failures into an actionable rebuild hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'No chrome package registered for chrome://branding/locale/brand.properties',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/distribution.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'])
    ).rejects.toThrow(/stale build artifacts/i);
  });

  it('separates stale-shaped failures after --build from stale deployed artifacts', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'No chrome package registered for chrome://branding/locale/brand.properties',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/distribution.sys.mjs',
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GeneralError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toContain('Post-rebuild test failure:');
    expect(message).toContain('already ran the requested rebuild');
    expect(message).toContain('runtime, registration, routing, or test-contract regression');
  });

  it('routes fork-module load failures to the module-registration hint (Eval 1 Finding #14)', async () => {
    // Both the fork-module signal AND the branding-stale signal fire
    // because the harness teardown prints a branding warning. The
    // fork-module diagnosis must win — telling the operator to rebuild
    // when the module is missing from moz.build sends them in a loop.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        'ERROR Error: Failed to load resource:///modules/mybrowser/MybrowserStore.sys.mjs\n' +
        'No chrome package registered for chrome://branding/locale/brand.properties',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_mybrowser_store.js'])
    ).rejects.toThrow(/module-registration issue/i);
  });

  it('rewrites missing generated branding moz.build failures into the same rebuild hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'mozbuild.frontend.reader.BuildReaderError: referenced a path that does not exist: /project/engine/browser/branding/mybrowser/moz.build',
    });

    await expect(
      testCommand('/project', [
        'browser/components/tests/unit/test_browserGlue_mybrowser_startup.js',
      ])
    ).rejects.toThrow(/stale build artifacts/i);
  });

  it('calls prepareBuildEnvironment before an incremental test rebuild', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(prepareBuildEnvironment).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ engine: '/project/engine' }),
      expect.objectContaining({ binaryName: 'mybrowser' }),
      // The pre-test build passes the previous baseline like `fireforge
      // build` does, so auto-configure conditions match on both paths.
      expect.objectContaining({})
    );
    expect(withBuildLock).toHaveBeenCalledWith('/project', expect.any(Function));
    expect(runProtectedMachBuild).toHaveBeenCalledWith(
      'faster',
      '/project/engine',
      expect.objectContaining({ retries: 2 })
    );
  });

  it('escalates a jar.mn-changing pre-test build to a full build', async () => {
    vi.mocked(prepareBuildEnvironment).mockResolvedValueOnce({
      furnaceApplied: 0,
      reconfigured: false,
      fullBuildRequired: true,
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
      build: true,
    });

    expect(runProtectedMachBuild).toHaveBeenCalledWith(
      'full',
      '/project/engine',
      expect.objectContaining({ retries: 2 })
    );
    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      ['browser/components/tests/unit/test_distribution.js'],
      undefined,
      'fireforge test --build browser/components/tests/unit/test_distribution.js',
      'refresh'
    );
  });

  it('fails with an AmbiguousBuildArtifactsError when multiple objdirs are detected', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({
      exists: true,
      ambiguous: true,
      objDirs: ['obj-debug', 'obj-opt'],
    });

    await expect(testCommand('/project', [], { auto: true })).rejects.toBeInstanceOf(
      AmbiguousBuildArtifactsError
    );

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('surfaces build artifact mismatch messages before invoking mach test', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValue({
      exists: true,
      objDir: 'obj-debug',
      metadataMismatch: { objDir: 'obj-debug', topsrcdir: '/other/workspace/engine' },
    });

    await expect(testCommand('/project', [], { auto: true })).rejects.toThrow(
      /copied or relocated build artifacts/i
    );

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('requires a completed build when no objdir exists and --build was not requested', async () => {
    vi.mocked(hasBuildArtifacts).mockResolvedValueOnce({ exists: false });

    await expect(testCommand('/project', [], { auto: true })).rejects.toThrow(
      'Tests require a completed build'
    );

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses inside a tree when the objdir found is not the one the marker vouched for', async () => {
    // The guard admits build-less in-tree test on the marker's clonedObjdir;
    // preflight must then prove the objdir it actually found IS that one —
    // any other objdir was never rewritten/reconfigured to the tree.
    vi.mocked(assertObjdirMatchesTreeMarker).mockRejectedValueOnce(
      new GeneralError('This verification tree\'s marker records "obj-e2e" as its cloned build')
    );

    await expect(testCommand('/project', [], { auto: true })).rejects.toThrow(
      /marker records "obj-e2e"/
    );

    expect(assertObjdirMatchesTreeMarker).toHaveBeenCalledWith('/project', 'obj-debug');
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('rejects pathless test runs without an explicit pathless mode', async () => {
    await expect(testCommand('/project', [])).rejects.toThrow(/requires an explicit test path/);
    expect(hasBuildArtifacts).not.toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('forwards --auto through generic mach test when no paths are provided', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | auto\nTEST-OK | auto',
      stderr: '',
    });

    await expect(testCommand('/project', [], { auto: true })).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      [],
      expect.arrayContaining(['--auto']),
      expect.objectContaining({ XPCSHELL_TEST_PROFILE_DIR: expect.any(String) as string })
    );
  });

  it('rejects --auto with explicit paths', async () => {
    await expect(
      testCommand('/project', ['browser/base/content/test/foo/browser_foo.js'], { auto: true })
    ).rejects.toThrow(/--auto.*only when no explicit paths/i);
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('fails --canary with setup guidance when no canary path is configured', async () => {
    await expect(testCommand('/project', [], { canary: true })).rejects.toThrow(
      /No test canary path is configured/
    );
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('reports a green canary verdict for the configured canary path', async () => {
    vi.mocked(loadConfig).mockResolvedValueOnce({
      name: 'MyBrowser',
      vendor: 'My Company',
      appId: 'org.example.mybrowser',
      binaryName: 'mybrowser',
      firefox: { version: '140.9.0esr', product: 'firefox-esr' },
      test: {
        canaryPath: 'browser/base/content/test/foo/browser_canary.js',
        canaryTimeoutSeconds: 12,
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | browser_canary.js\nTEST-OK | browser_canary.js',
      stderr: '',
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(testCommand('/project', [], { canary: true })).resolves.toBeUndefined();

      expect(testWithOutput).toHaveBeenCalledWith(
        '/project/engine',
        ['browser/base/content/test/foo/browser_canary.js'],
        expect.arrayContaining(['--timeout=12'])
      );
      expect(success).toHaveBeenCalledWith('Canary: green');
      // FORGE I5: the canary path ends with the machine-readable verdict.
      const rawWrites = writeSpy.mock.calls
        .map((args) => args[0])
        .filter((chunk): chunk is string => typeof chunk === 'string');
      expect(rawWrites.at(-1)).toMatch(/^FIREFORGE-VERDICT: PASS/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('classifies a canary no-output timeout as hang', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'TEST-INFO | timed out after 60 seconds with no output',
      stderr: '',
    });

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        testCommand('/project', [], {
          canary: 'browser/base/content/test/foo/browser_canary.js',
        })
      ).rejects.toThrow(/Canary: hang/);

      // FORGE I5: the FAIL verdict line is emitted before the throw
      // propagates, so it is the canary run's last stdout write.
      const rawWrites = writeSpy.mock.calls
        .map((args) => args[0])
        .filter((chunk): chunk is string => typeof chunk === 'string');
      expect(rawWrites.at(-1)).toMatch(/^FIREFORGE-VERDICT: FAIL reason=crash/);
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('throws a BuildError when the incremental pre-test build fails', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
      attempts: 1,
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BuildError);
    const message = error instanceof Error ? error.message : '';
    expect(message).not.toContain('Post-rebuild test failure:');

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  // ── Item E2 (0.32.0) / 0.34.0: pre-test --build routes through the
  //    protected mach dispatch (in-venv guard + uniform crash retries) ──

  it('proceeds to tests when the protected pre-test build recovered via retry (E2)', async () => {
    // The protected dispatch retried internally and reports success on the
    // second attempt; the command layer proceeds to mach test.
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 2,
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(runProtectedMachBuild).toHaveBeenCalledTimes(1);
    expect(testWithOutput).toHaveBeenCalled();
  });

  it('forwards --harness-retries into the protected pre-test build and reports an exhausted crash budget (E2)', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: '',
      attempts: 2,
      crashSignature: {
        reason: 'harness startup traceback (resource monitor/psutil)',
        line: "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
      },
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
        harnessRetries: 1,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BuildError);
    expect(runProtectedMachBuild).toHaveBeenCalledWith(
      'faster',
      '/project/engine',
      expect.objectContaining({ retries: 1 })
    );
    expect(testWithOutput).not.toHaveBeenCalled();
    expect(error instanceof Error ? error.message : '').toMatch(/harness/i);
  });

  it('reports a plain pre-test build failure without the crash framing (E2 — only harness crashes retry)', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 1,
      stdout: 'make: real error',
      stderr: '',
      attempts: 1,
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
        harnessRetries: 2,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BuildError);
    expect(error instanceof Error ? error.message : '').not.toMatch(/crashed in the harness/i);
  });

  it('runs prepareBuildEnvironment once, outside the protected retry loop', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 3, // dispatch retried twice internally
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    // Retries must never re-run mach configure / build prep — the field's
    // 64-minute rebuild incident is exactly what re-preparing would risk.
    expect(prepareBuildEnvironment).toHaveBeenCalledTimes(1);
  });

  it('treats a green embedded summary with a non-zero exit as a pass (0.34.0 --no-shard field case)', async () => {
    // mach exited 1 on harness noise (degradation warnings + caught
    // telemetry traceback), but the embedded summary completed green — the
    // wrapper must exit 0 instead of forcing operators to parse embedded
    // summaries by hand.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: [
        'UserWarning: psutil failed to run: host_statistics64 syscall failed',
        // The requested file must appear started AND ended: a green
        // summary whose requested files never ran is precisely what the
        // 0.35.0 crash green-wash fix now rejects.
        ' 0:00.60 TEST_START | browser/components/tests/unit/test_distribution.js',
        ' 0:02.18 INFO | TEST_END: Test PASS',
        'Traceback (most recent call last):',
        '  File "mach/telemetry.py", line 661, in submit_telemetry',
        'ConnectionError: telemetry submission failed',
        ' 0:04.10 INFO | Unexpected results: 0',
        ' 0:04.11 SUITE_END',
      ].join('\n'),
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'])
    ).resolves.toBeUndefined();
  });

  it('sharded green runs with degradation noise pass instead of reporting CRASH (0.34.0)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: [
        'UserWarning: psutil failed to run: host_statistics64 syscall failed',
        '_collect failed: poll_interval unavailable',
        ' 0:00.60 TEST_START | shard-test',
        ' 0:02.18 INFO | TEST_END: Test PASS',
        ' 0:04.10 INFO | Unexpected results: 0',
        ' 0:04.11 SUITE_END',
      ].join('\n'),
      stderr: '',
    });

    await expect(
      testCommand('/project', [
        'browser/components/tests/unit/test_one.js',
        'browser/components/tests/unit/test_two.js',
      ])
    ).resolves.toBeUndefined();
  });

  it('announces per-file sharding and points at --no-shard (drill finding: silent shards mask cross-file state bugs)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nUnexpected results: 0\nSUITE_END',
      stderr: '',
    });

    await testCommand('/project', [
      'browser/components/tests/unit/test_one.js',
      'browser/components/tests/unit/test_two.js',
    ]);

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Cross-argument state is NOT exercised — pass --no-shard')
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('running 2 test path arguments'));
  });

  it('does not announce sharding for a single path or under --no-shard', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nUnexpected results: 0\nSUITE_END',
      stderr: '',
    });

    await testCommand('/project', ['browser/components/tests/unit/test_one.js']);
    await testCommand(
      '/project',
      ['browser/components/tests/unit/test_one.js', 'browser/components/tests/unit/test_two.js'],
      { shard: false }
    );

    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('pass --no-shard'));
  });

  it('dispatches a directory argument as its explicit file list in ONE invocation and echoes excluded prefix siblings', async () => {
    // The drill's exact failure shape: `…/test/hominis` also ran the
    // sibling `…/test/hominis-tiles` via mach's string-prefix match —
    // and 0.35.0's trailing-slash form did NOT stop it (field
    // verification: all 33 hominis-tiles files still ran while the echo
    // claimed exclusion). The dispatch must be the enumerated explicit
    // file list (which cannot prefix-match a sibling), in a single mach
    // invocation so cross-file state still carries within the directory.
    const hominisFiles = [
      'browser/base/content/test/hominis/browser_one.js',
      'browser/base/content/test/hominis/browser_two.js',
      'browser/base/content/test/hominis/nested/browser_three.js',
    ];
    vi.mocked(analyzeTestPathScopes).mockResolvedValueOnce([
      {
        requestedPath: 'browser/base/content/test/hominis',
        dispatchPaths: hominisFiles,
        isDirectory: true,
        testFileCount: 3,
        siblingPrefixMatches: [
          { path: 'browser/base/content/test/hominis-tiles', testFileCount: 1026 },
        ],
      },
    ]);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nUnexpected results: 0\nSUITE_END',
      stderr: '',
    });

    await testCommand('/project', ['browser/base/content/test/hominis']);

    // One combined invocation carrying exactly the directory's own files:
    // a prefix-named sibling cannot be swept in, and the one-browser-
    // instance semantics of a directory run are preserved.
    expect(testWithOutput).toHaveBeenCalledTimes(1);
    expect(testWithOutput).toHaveBeenCalledWith('/project/engine', hominisFiles, []);
    // No sharding notice for a single directory argument.
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('pass --no-shard'));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Selected exactly browser/base/content/test/hominis/')
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('hominis-tiles/ (1026 test files)'));
  });

  it('shards a directory + file mix per argument, keeping the directory files in one invocation', async () => {
    const dirFiles = [
      'browser/base/content/test/hominis/browser_one.js',
      'browser/base/content/test/hominis/browser_two.js',
    ];
    vi.mocked(analyzeTestPathScopes).mockResolvedValueOnce([
      {
        requestedPath: 'browser/base/content/test/hominis',
        dispatchPaths: dirFiles,
        isDirectory: true,
        testFileCount: 2,
        siblingPrefixMatches: [],
      },
      {
        requestedPath: 'browser/components/tests/browser_other.js',
        dispatchPaths: ['browser/components/tests/browser_other.js'],
        isDirectory: false,
        testFileCount: 0,
        siblingPrefixMatches: [],
      },
    ]);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nUnexpected results: 0\nSUITE_END',
      stderr: '',
    });

    await testCommand('/project', [
      'browser/base/content/test/hominis',
      'browser/components/tests/browser_other.js',
    ]);

    expect(testWithOutput).toHaveBeenCalledTimes(2);
    expect(testWithOutput).toHaveBeenNthCalledWith(1, '/project/engine', dirFiles, []);
    expect(testWithOutput).toHaveBeenNthCalledWith(
      2,
      '/project/engine',
      ['browser/components/tests/browser_other.js'],
      []
    );
  });

  it('normalizes engine-prefixed test paths and passes headless through to mach test', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['engine/browser/components/tests/unit/test_distribution.js'], {
        headless: true,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      ['--headless']
    );
  });

  it('strips a case-insensitive engine prefix on case-insensitive filesystems', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['Engine/browser/components/tests/unit/test_distribution.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('strips engine prefix using a Windows-style backslash separator', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['engine\\browser\\components\\tests\\unit\\test_distribution.js'])
    ).resolves.toBeUndefined();

    // backslashes survive into mach (Windows mach handles them), but the
    // engine prefix is stripped.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser\\components\\tests\\unit\\test_distribution.js'],
      []
    );
  });

  it('trims surrounding whitespace from supplied test paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['  engine/browser/components/tests/unit/test_distribution.js  '])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('runs the marionette preflight without calling mach test when --doctor is supplied alone', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 200,
      detail: 'handshake',
    });
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });

    try {
      await expect(testCommand('/project', [], { doctor: true })).resolves.toBeUndefined();

      expect(runMarionettePreflight).toHaveBeenCalledWith('/project/engine');
      expect(reportMarionettePreflight).toHaveBeenCalled();
      expect(testWithOutput).not.toHaveBeenCalled();
      // 2026-04-24 eval Finding 7: the doctor-only success path now writes
      // the PASS line via `process.stdout.write` as the authoritative
      // emission so non-TTY captures always see the summary. The clack
      // `success()` + `outro('Test completed')` calls stay for TTY users
      // who rely on the visual framing.
      expect(success).toHaveBeenCalledWith(expect.stringMatching(/Marionette preflight: PASS/));
      expect(outro).toHaveBeenCalledWith('Test completed');
      const rawWrites = writeSpy.mock.calls
        .map((args) => args[0])
        .filter((chunk): chunk is string => typeof chunk === 'string');
      expect(rawWrites.some((chunk) => /Running marionette preflight\.\.\./.test(chunk))).toBe(
        true
      );
      expect(rawWrites.some((chunk) => /Marionette preflight: PASS \(200ms\)/.test(chunk))).toBe(
        true
      );
      expect(
        rawWrites.some((chunk) =>
          /Marionette preflight environment: objdir=obj-debug; binary=mybrowser; app=engine\/obj-debug\/dist\/bin\/firefox; port=2828; elapsed=200ms/.test(
            chunk
          )
        )
      ).toBe(true);
      // FORGE I5: doctor-only runs end with the machine-readable verdict.
      expect(rawWrites).toContain('FIREFORGE-VERDICT: PASS\n');
    } finally {
      writeSpy.mockRestore();
      if (ttyDescriptor) {
        Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, 'isTTY');
      }
    }
  });

  it('surfaces a FAIL preflight as an actionable error and does not invoke mach test', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: false,
      durationMs: 12_000,
      detail: 'socket timeout',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        doctor: true,
      })
    ).rejects.toThrow(/Marionette preflight reported FAIL/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('fails up-front when the stale-build preflight reports packageable engine changes', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce({
      stale: true,
      changedPaths: ['browser/base/content/mybrowser.xhtml', 'browser/base/content/mybrowser.js'],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc123',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).rejects.toThrow(/--allow-stale-build/);

    // The warning must fire before mach test — the user's feedback was that
    // discovering stale artifacts AFTER xpcshell launches gives no actionable
    // signal in time.
    expect(checkStaleBuildForTest).toHaveBeenCalledWith('/project', '/project/engine');
    expect(formatStaleBuildWarning).toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalledWith('stale warning');
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('allows stale-build test runs with --allow-stale-build', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce({
      stale: true,
      changedPaths: ['browser/base/content/mybrowser.xhtml'],
      truncated: 0,
      baseline: {
        engineHeadSha: 'abc123',
        builtAt: new Date().toISOString(),
        binaryName: 'mybrowser',
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        allowStaleBuild: true,
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale warning'));
    expect(testWithOutput).toHaveBeenCalled();
  });

  it('skips the stale-build preflight when --build was requested', async () => {
    // --build already refreshes the obj-* bundle, so an additional
    // stale-build warning would be actively misleading — it reports drift
    // against a baseline that the rebuild just invalidated.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(checkStaleBuildForTest).not.toHaveBeenCalled();
  });

  it('does not warn when the stale-build preflight reports no packageable changes', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    // Default mock already returns stale: false.

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'])
    ).resolves.toBeUndefined();

    expect(checkStaleBuildForTest).toHaveBeenCalled();
    expect(formatStaleBuildWarning).not.toHaveBeenCalled();
  });

  // ── 0.37.0 items 1+2: a green pre-test build refreshes the stale-build
  //    baseline exactly like `fireforge build` does, so any later plain
  //    `fireforge test` invocation shape over the same files passes the gate ──

  it('writes the build baseline after a green pre-test --build, scoped to the requested paths', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).resolves.toBeUndefined();

    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      ['browser/components/tests/unit/test_distribution.js'],
      undefined,
      'fireforge test --build browser/components/tests/unit/test_distribution.js',
      'auto'
    );
    // Same ordering contract as `fireforge build`: the baseline records a
    // build that actually completed.
    const buildOrder = vi.mocked(runProtectedMachBuild).mock.invocationCallOrder[0];
    const baselineOrder = vi.mocked(writeBuildBaseline).mock.invocationCallOrder[0];
    expect(baselineOrder).toBeGreaterThan(buildOrder ?? Infinity);
  });

  it('writes a directory-scoped coverage claim for a directory --build invocation', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit'], { build: true })
    ).resolves.toBeUndefined();

    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      ['browser/components/tests/unit'],
      undefined,
      'fireforge test --build browser/components/tests/unit',
      'auto'
    );
  });

  it('records full coverage for a path-less --build --auto run', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });

    await expect(testCommand('/project', [], { build: true, auto: true })).resolves.toBeUndefined();

    expect(writeBuildBaseline).toHaveBeenCalledWith(
      '/project',
      '/project/engine',
      'mybrowser',
      'full',
      undefined,
      'fireforge test --build',
      'auto'
    );
  });

  it('does not write a baseline when the pre-test build fails', async () => {
    vi.mocked(runProtectedMachBuild).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: '',
      attempts: 1,
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        build: true,
      })
    ).rejects.toThrow();

    expect(writeBuildBaseline).not.toHaveBeenCalled();
  });

  // ── 0.37.0 item 3: every non---build run is refused when the packaged
  //    runtime does not cover it, instead of dispatching into a fixture
  //    hang; --allow-stale-build only accepts stale content ──

  const scopedCoverageBaseline = (
    stale: boolean
  ): Awaited<ReturnType<typeof checkStaleBuildForTest>> => ({
    stale,
    changedPaths: stale ? ['browser/components/tiles/content/tiles.mjs'] : [],
    truncated: 0,
    baseline: {
      engineHeadSha: 'abc123',
      builtAt: new Date().toISOString(),
      binaryName: 'mybrowser',
      testPackagingCoverage: ['browser/components/tiles/test/browser/browser_tiles.js'],
    },
  });

  it('refuses --allow-stale-build over paths outside the recorded packaging coverage (stale tree)', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(true));

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'], {
        allowStaleBuild: true,
      })
    ).rejects.toThrow(/browser\/components\/history\/test\/browser\/browser_hist\.js/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses uncovered --allow-stale-build even when nothing changed since the scoped rebuild', async () => {
    // The field-incident shape: the tree is NOT stale relative to the scoped
    // rebuild, but the packaged runtime never contained the other manifest's
    // support fixtures — dispatching would hang, not fail.
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'], {
        allowStaleBuild: true,
      })
    ).rejects.toThrow(/does not cover/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('lets a covered --allow-stale-build re-run proceed with the stale warning', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(true));
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tiles/test/browser/browser_tiles.js'], {
        allowStaleBuild: true,
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stale warning'));
    expect(testWithOutput).toHaveBeenCalled();
  });

  it('enforces coverage on plain runs too — the coverage refusal beats the stale refusal', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(true));

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'])
    ).rejects.toThrow(/does not cover/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses an uncovered plain run even when nothing changed since the scoped rebuild', async () => {
    // The field-incident shape without the flag: unchanged tree, so the
    // stale gate stays silent — only the coverage check stands between
    // the dispatch and a missing-fixture hang.
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'])
    ).rejects.toThrow(/does not cover/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses a full-suite plain run against scoped coverage, naming the entire suite', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));

    await expect(testCommand('/project', [], { auto: true })).rejects.toThrow(/\(entire suite\)/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('exempts a path-less --doctor run from the coverage gate (no test is dispatched)', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 200,
      detail: 'handshake',
    });

    await expect(testCommand('/project', [], { doctor: true })).resolves.toBeUndefined();

    expect(runMarionettePreflight).toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('still refuses a stale-tree path-less --doctor run (only the coverage gate is exempt)', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(true));

    await expect(testCommand('/project', [], { doctor: true })).rejects.toThrow(
      /--allow-stale-build/
    );

    expect(runMarionettePreflight).not.toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('does not exempt a --doctor run WITH test paths from the coverage gate', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'], {
        doctor: true,
      })
    ).rejects.toThrow(/does not cover/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('still refuses a covered-but-stale plain run with the ordinary stale message', async () => {
    // Coverage passing must not swallow the stale refusal — the flag's
    // stale-content semantics are all it controls now.
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(true));

    await expect(
      testCommand('/project', ['browser/components/tiles/test/browser/browser_tiles.js'])
    ).rejects.toThrow(/--allow-stale-build/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('treats a baseline without testPackagingCoverage as full coverage (pre-0.37.0)', async () => {
    const legacy = scopedCoverageBaseline(false);
    delete (legacy.baseline as { testPackagingCoverage?: unknown }).testPackagingCoverage;
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(legacy);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/history/test/browser/browser_hist.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalled();
  });

  // ── 0.38.0 item 5: coverage is manifest-granular — a scoped rebuild
  //    staged the whole manifest directory, so a same-manifest sibling of a
  //    covered file must pass the coverage gate ──

  it('lets a same-manifest sibling of the covered file pass the coverage gate', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(scopedCoverageBaseline(false));
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    // Coverage records …/browser_tiles.js; the sibling lives in the same
    // manifest directory and was staged by the same scoped rebuild.
    await expect(
      testCommand('/project', ['browser/components/tiles/test/browser/browser_other.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalled();
  });

  // ── 0.38.0 item 2: components.conf registrations bake into the compiled
  //    StaticComponents table that only a FULL build regenerates — refuse
  //    runs that would resolve the old table ──

  it('refuses a scoped test --build when components.conf changed since the last full build', async () => {
    vi.mocked(checkStaticComponentsStale).mockResolvedValueOnce({
      stale: true,
      changedManifests: ['browser/components/mybrowser/components.conf'],
    });

    let error: unknown;
    try {
      await testCommand('/project', ['browser/components/mybrowser/test/unit/test_reg.js'], {
        build: true,
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(GeneralError);
    const message = error instanceof Error ? error.message : '';
    expect(message).toMatch(/NS_ERROR_MALFORMED_URI/);
    expect(message).toMatch(/fireforge build/);
    // The gate runs BEFORE the pre-test build — a scoped `mach build
    // faster` cannot fix the compiled table, so building first would
    // only waste the operator's time.
    expect(runProtectedMachBuild).not.toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses a build-less run over a stale StaticComponents table, naming the manifest', async () => {
    vi.mocked(checkStaticComponentsStale).mockResolvedValueOnce({
      stale: true,
      changedManifests: ['browser/components/mybrowser/components.conf'],
    });

    await expect(
      testCommand('/project', ['browser/components/mybrowser/test/unit/test_reg.js'])
    ).rejects.toThrow(/browser\/components\/mybrowser\/components\.conf/);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('downgrades the StaticComponents refusal to a warning with --allow-stale-components', async () => {
    vi.mocked(checkStaticComponentsStale).mockResolvedValueOnce({
      stale: true,
      changedManifests: ['browser/components/mybrowser/components.conf'],
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/mybrowser/test/unit/test_reg.js'], {
        allowStaleComponents: true,
      })
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('NS_ERROR_MALFORMED_URI'));
    expect(testWithOutput).toHaveBeenCalled();
  });

  it('proceeds to mach test when the preflight passes and test paths are supplied', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 120,
      detail: 'handshake',
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/dummy/browser_dummy.js'], {
        doctor: true,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalled();
  });

  it('rewrites xpcshell resource:///modules/ failures into the appdir hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/CanvasMath.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_canvas_math.js'])
    ).rejects.toThrow(/xpcshell failed to load core resource:\/\/\/modules/);
  });

  it('throws the xpcshell appdir hint as GeneralError, not BuildError', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('falls through to the xpcshell-appdir hint when only resource:///modules/* is named', async () => {
    // 0.16.0 narrowing: the stale-build signal no longer matches
    // `resource:///modules/distribution.sys.mjs` on its own — that literal
    // was producing false-positive "rebuild" advice for fork-custom
    // module-load failures (the eval saw this for
    // `MyBrowserStore.sys.mjs`, which was actually an appdir issue). A
    // generic `Failed to load resource:///modules/…` now routes straight
    // to the xpcshell-appdir hint, which is the right first guess in
    // practice. Branding-specific stale signals (brand.properties,
    // branding moz.build) still win ahead of xpcshell-appdir.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/distribution.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'])
    ).rejects.toThrow(/xpcshell failed to load core resource/i);
  });

  it('routes fork-custom resource module failures to the xpcshell-appdir hint', async () => {
    // A fork-shaped resource path whose module subdirectory does NOT match
    // this project's binaryName ("mybrowser") used to surface as "rebuild"
    // advice via the broader `resource:///modules/…` pattern. After the
    // 0.16.0 narrowing the right hint wins — app-path injection, not
    // rebuild — when the fork-module signal does not match the configured
    // binaryName.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        'ERROR Unexpected exception Error: Failed to load resource:///modules/otherfork/OtherForkStore.sys.mjs',
    });

    await expect(
      testCommand('/project', [
        'browser/components/tests/unit/test_browserGlue_otherfork_startup.js',
      ])
    ).rejects.toThrow(/xpcshell failed to load core resource/i);
  });

  it('rewrites the MochitestDesktop http3Server AttributeError into the branding-registration hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr:
        "File \"/project/engine/obj-debug/_tests/testing/mochitest/runtests.py\", line 1519, in stopServers: if self.http3Server is not None: AttributeError: 'MochitestDesktop' object has no attribute 'http3Server'",
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_canvas.js'])
    ).rejects.toThrow(/chrome:\/\/branding/);
  });

  it('throws the mochitest http3Server hint as GeneralError, not BuildError', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: "AttributeError: 'MochitestDesktop' object has no attribute 'http3Server'",
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/browser_mybrowser_canvas.js'])
    ).rejects.toBeInstanceOf(GeneralError);
  });

  it('rewrites stale mochitest symlink setup failures into a harness-state hint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'FileExistsError: [Errno 17] File exists: mochitest',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).rejects.toThrow(/stale harness setup/i);
  });

  it('removes a stale xpcshell _tests symlink and retries mach test once', async () => {
    const staleLink =
      '/project/engine/obj-debug/_tests/xpcshell/toolkit/mozapps/extensions/test/xpcshell/data/bug455906_block.xml';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: `FileExistsError: [Errno 17] File exists: '/src/bug455906_block.xml' -> '${staleLink}'`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
        stderr: '',
      });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).resolves.toBeUndefined();

    expect(removeFile).toHaveBeenCalledWith(staleLink);
    expect(testWithOutput).toHaveBeenCalledTimes(2);
  });

  it('removes stale xpcshell install symlinks under the shared mochitest harness tree', async () => {
    const staleLink =
      '/project/engine/obj-debug/_tests/testing/mochitest/browser/browser/extensions/formautofill/test/fixtures/autocomplete_address_basic.html';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/extensions/formautofill/test/unit/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput)
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: `FileExistsError: [Errno 17] File exists: '/src/autocomplete_address_basic.html' -> '${staleLink}'`,
        stderr: '',
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
        stderr: '',
      });

    await expect(
      testCommand('/project', ['browser/extensions/formautofill/test/unit/test_sync.js'])
    ).resolves.toBeUndefined();

    expect(removeFile).toHaveBeenCalledWith(staleLink);
    expect(testWithOutput).toHaveBeenCalledTimes(2);
  });

  it('does not remove FileExistsError destinations outside the active _tests tree', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(true);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout:
        "xpcshell FileExistsError: [Errno 17] File exists: '/src' -> '/tmp/not-fireforge.xml'",
      stderr: '',
    });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).rejects.toThrow(/stale harness setup/i);

    expect(removeFile).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledTimes(1);
  });

  it('does not remove a stale xpcshell destination unless it is a symlink', async () => {
    const stalePath = '/project/engine/obj-debug/_tests/xpcshell/data/bug455906_block.xml';
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/toolkit/mozapps/extensions/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(isSymlink).mockResolvedValue(false);
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: `FileExistsError: [Errno 17] File exists: '/src' -> '${stalePath}'`,
      stderr: '',
    });

    await expect(
      testCommand('/project', [
        'toolkit/mozapps/extensions/test/xpcshell/test_bug455906_blocklist.js',
      ])
    ).rejects.toThrow(/stale harness setup/i);

    expect(removeFile).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledTimes(1);
  });

  it('forwards --mach-arg values verbatim to testWithOutput after --headless', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        headless: true,
        machArg: ['--verbose', '--keep-going'],
      })
    ).resolves.toBeUndefined();

    // Order matters: FireForge-managed flags first, passthrough last.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      ['--headless', '--verbose', '--keep-going']
    );
  });

  it('filters redundant --flavor=xpcshell when xpcshell is inferred from the manifest', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/foo/xpcshell.toml'
    );

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'], {
        machArg: ['--flavor=xpcshell', '--verbose'],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--verbose'],
      expect.objectContaining({ XPCSHELL_TEST_PROFILE_DIR: expect.any(String) as string })
    );
  });

  it('fails before mach when xpcshell and browser paths are mixed', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
    );

    await expect(
      testCommand('/project', [
        'browser/base/content/test/xpcshell/test_tile.js',
        'browser/base/content/test/browser/browser_tile.js',
      ])
    ).rejects.toThrow(/cannot run xpcshell and browser\/mochitest paths/i);

    expect(testWithOutput).not.toHaveBeenCalled();
  });

  it('refuses a mixed request before dispatching the pre-test build (FORGE F7)', async () => {
    vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
      Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
    );

    await expect(
      testCommand(
        '/project',
        [
          'browser/base/content/test/xpcshell/test_tile.js',
          'browser/base/content/test/browser/browser_tile.js',
        ],
        { build: true }
      )
    ).rejects.toThrow(/cannot run xpcshell and browser\/mochitest paths/i);

    expect(runProtectedMachBuild).not.toHaveBeenCalled();
    expect(testWithOutput).not.toHaveBeenCalled();
  });

  function captureStdout(): { verdicts: () => string[]; restore: () => void } {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    return {
      verdicts: () => writes.filter((w) => w.startsWith('FIREFORGE-VERDICT:')),
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  describe('--build-only union build (FORGE J9)', () => {
    const MIXED_PATHS = [
      'browser/base/content/test/xpcshell/test_tile.js',
      'browser/base/content/test/browser/browser_tile.js',
    ];

    it('accepts mixed harness paths, builds once with union coverage, and never dispatches', async () => {
      vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
        Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
      );

      const capture = captureStdout();
      try {
        await expect(
          testCommand('/project', MIXED_PATHS, { buildOnly: true })
        ).resolves.toBeUndefined();
      } finally {
        capture.restore();
      }

      expect(runProtectedMachBuild).toHaveBeenCalledTimes(1);
      expect(testWithOutput).not.toHaveBeenCalled();
      expect(xpcshellTestWithOutput).not.toHaveBeenCalled();
      // The baseline coverage claim lists BOTH harness halves.
      expect(writeBuildBaseline).toHaveBeenCalledWith(
        '/project',
        '/project/engine',
        expect.any(String),
        MIXED_PATHS,
        undefined,
        expect.stringContaining('fireforge test --build'),
        'auto'
      );
      expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: PASS\n']);
      expect(info).toHaveBeenCalledWith('Run each harness separately without --build:');
    });

    it('still refuses mixed paths without --build-only', async () => {
      vi.mocked(findNearestXpcshellManifest).mockImplementation((_engineDir, path) =>
        Promise.resolve(path.includes('/xpcshell/') ? '/project/engine/foo/xpcshell.toml' : null)
      );

      await expect(testCommand('/project', MIXED_PATHS, { build: true })).rejects.toThrow(
        /cannot run xpcshell and browser\/mochitest paths/i
      );
      expect(runProtectedMachBuild).not.toHaveBeenCalled();
    });

    it('rejects --build-only with mode flags', async () => {
      await expect(testCommand('/project', [], { buildOnly: true, doctor: true })).rejects.toThrow(
        /--build-only.*cannot be combined with --doctor/s
      );
    });
  });

  describe('--extend-coverage union claim (FORGE L1)', () => {
    const SLICE_A = 'browser/base/content/test/a/browser_a.js';
    const SLICE_B = 'browser/base/content/test/b/browser_b.js';

    function greenBuild(): void {
      vi.mocked(runProtectedMachBuild).mockResolvedValue({
        exitCode: 0,
        stdout: '',
        stderr: '',
        attempts: 1,
      });
      vi.mocked(testWithOutput).mockResolvedValue({
        exitCode: 0,
        stdout: 'TEST-START | t\nTEST-OK | t',
        stderr: '',
      });
    }

    it('unions the new paths onto the recorded scoped claim', async () => {
      greenBuild();
      vi.mocked(readBuildBaseline).mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: '2026-08-11T00:00:00.000Z',
        binaryName: 'mybrowser',
        testPackagingCoverage: [SLICE_A],
      });

      await expect(
        testCommand('/project', [SLICE_B], { build: true, extendCoverage: true })
      ).resolves.toBeUndefined();

      expect(writeBuildBaseline).toHaveBeenCalledWith(
        '/project',
        '/project/engine',
        'mybrowser',
        [SLICE_A, SLICE_B],
        expect.anything(),
        expect.stringContaining('--extend-coverage'),
        'carry-forward'
      );
    });

    it("keeps a 'full' claim full and still carries the static-components anchor forward", async () => {
      greenBuild();
      vi.mocked(readBuildBaseline).mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: '2026-08-11T00:00:00.000Z',
        binaryName: 'mybrowser',
        testPackagingCoverage: 'full',
      });

      await expect(
        testCommand('/project', [SLICE_B], { build: true, extendCoverage: true })
      ).resolves.toBeUndefined();

      // 'carry-forward' matters precisely here: the union evaluates to
      // 'full', but the build behind it was a scoped `mach build faster`
      // that did not rebake the compiled StaticComponents table.
      expect(writeBuildBaseline).toHaveBeenCalledWith(
        '/project',
        '/project/engine',
        'mybrowser',
        'full',
        expect.anything(),
        expect.any(String),
        'carry-forward'
      );
    });

    it('refuses before building when the head/fingerprint anchor moved', async () => {
      greenBuild();
      vi.mocked(checkExtendCoverageAnchor).mockResolvedValueOnce({
        ok: false,
        reason: 'head-moved',
        detail: ['recorded abc', 'current def'],
      });

      await expect(
        testCommand('/project', [SLICE_B], { build: true, extendCoverage: true })
      ).rejects.toThrow(/--extend-coverage refused: engine HEAD moved/);

      expect(runProtectedMachBuild).not.toHaveBeenCalled();
      expect(writeBuildBaseline).not.toHaveBeenCalled();
    });

    it('refuses on a regenerated mozconfig, after prepare but before mach', async () => {
      greenBuild();
      vi.mocked(checkExtendMozconfigAnchor).mockResolvedValueOnce({
        ok: false,
        reason: 'mozconfig-changed',
        detail: [],
      });

      await expect(
        testCommand('/project', [SLICE_B], { build: true, extendCoverage: true })
      ).rejects.toThrow(/engine\/mozconfig differs from the recorded build/);

      expect(runProtectedMachBuild).not.toHaveBeenCalled();
    });

    it('refuses when no previous baseline exists', async () => {
      greenBuild();
      vi.mocked(checkExtendCoverageAnchor).mockResolvedValueOnce({
        ok: false,
        reason: 'no-baseline',
        detail: [],
      });

      await expect(
        testCommand('/project', [SLICE_B], { build: true, extendCoverage: true })
      ).rejects.toThrow(/nothing to extend/);
    });

    it('is refused without --build/--build-only', async () => {
      await expect(testCommand('/project', [SLICE_B], { extendCoverage: true })).rejects.toThrow(
        /--extend-coverage requires --build or --build-only/
      );
    });

    it('is refused for a path-less build (full coverage already covers everything)', async () => {
      await expect(
        testCommand('/project', [], { build: true, auto: true, extendCoverage: true })
      ).rejects.toThrow(/--extend-coverage requires explicit test paths/);
    });

    it('composes with --build-only, which is the union-build shape it exists for', async () => {
      greenBuild();
      vi.mocked(readBuildBaseline).mockResolvedValue({
        engineHeadSha: 'abc',
        builtAt: '2026-08-11T00:00:00.000Z',
        binaryName: 'mybrowser',
        testPackagingCoverage: [SLICE_A],
      });

      const capture = captureStdout();
      try {
        await expect(
          testCommand('/project', [SLICE_B], { buildOnly: true, extendCoverage: true })
        ).resolves.toBeUndefined();
      } finally {
        capture.restore();
      }

      expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: PASS\n']);
      expect(writeBuildBaseline).toHaveBeenCalledWith(
        '/project',
        '/project/engine',
        'mybrowser',
        [SLICE_A, SLICE_B],
        expect.anything(),
        expect.stringContaining('--extend-coverage'),
        'carry-forward'
      );
    });
  });

  it('skips the Marionette preflight and client flags for xpcshell-only runs (FORGE F10)', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
    const [, , extraArgs] = vi.mocked(xpcshellTestWithOutput).mock.calls[0] ?? [];
    expect(extraArgs).not.toEqual(
      expect.arrayContaining([expect.stringContaining('--setpref=marionette.port')])
    );
    expect(extraArgs).not.toEqual(
      expect.arrayContaining([expect.stringContaining('--marionette=')])
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('preflight probe only'));
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('Skipping the Marionette stale-port preflight')
    );
  });

  it('xpcshell-only + --kill-stale-marionette does not touch the port (FORGE F10)', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        killStaleMarionette: true,
      })
    ).resolves.toBeUndefined();

    expect(ensureMarionettePortAvailable).not.toHaveBeenCalled();
    expect(assertMarionettePortAvailable).not.toHaveBeenCalled();
    expect(ensureLaunchableBrowserNotRunning).not.toHaveBeenCalled();
  });

  it('keeps the Marionette preflight for xpcshell-only --doctor runs (FORGE F10)', async () => {
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(
      '/project/engine/browser/base/content/test/xpcshell/xpcshell.toml'
    );
    vi.mocked(xpcshellTestWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/xpcshell/test_tile.js'], {
        doctor: true,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalled();
  });

  it('ignores an empty --mach-arg array without appending anything', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/tests/unit/test_distribution.js'], {
        machArg: [],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/components/tests/unit/test_distribution.js'],
      []
    );
  });

  it('auto-injects --app-path when the resolver returns an "injected" outcome', async () => {
    // Simulates a rebranded fork (appname=mybrowser) whose xpcshell.toml
    // sets `firefox-appdir = "browser"`. The resolver returns the
    // absolute path it computed against obj-debug/dist/, and the test
    // command must append `--app-path=<abs>` to the mach test args so
    // the harness uses the right root rather than falling back to xrePath.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'injected',
      result: {
        appPath: '/project/engine/obj-debug/dist/bin/browser',
        manifestPath: '/project/engine/browser/base/content/test/foo/xpcshell.toml',
        key: 'firefox-appdir',
        relativeAppdir: 'browser',
      },
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).resolves.toBeUndefined();

    expect(resolveXpcshellAppdirArg).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      'obj-debug'
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--app-path=/project/engine/obj-debug/dist/bin/browser']
    );
  });

  it('does not auto-inject when the operator already passed --app-path via --mach-arg', async () => {
    // Operator override takes precedence: the resolver must not even be
    // consulted to compute its outcome. The recorded call confirms the
    // skip path runs before resolution.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(operatorAlreadySetAppPath).mockReturnValueOnce(true);

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'], {
        machArg: ['--app-path=/custom/path'],
      })
    ).resolves.toBeUndefined();

    expect(resolveXpcshellAppdirArg).not.toHaveBeenCalled();
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/foo/test_x.js'],
      ['--app-path=/custom/path']
    );
  });

  it('warns and skips injection when the resolver reports a mismatch across paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'mismatch',
      values: ['/p/A/dist/bin/browser', '/p/B/dist/bin/xulrunner'],
    });

    // Multi-path appdir mismatch only arises in a combined invocation;
    // default sharding would probe each path's manifest separately.
    await expect(
      testCommand(
        '/project',
        ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
        { shard: false }
      )
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/multiple test paths resolved to different app dirs/)
    );
    // No --app-path injected.
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/A/test_a.js', 'browser/base/content/test/B/test_b.js'],
      []
    );
  });

  it('warns and skips injection when the resolver cannot find the appdir under dist', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'unresolved',
      relativeAppdir: 'browser',
      manifestPath: '/project/engine/browser/base/content/test/foo/xpcshell.toml',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/foo/test_x.js'])
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/no matching directory exists under obj-debug\/dist/)
    );
  });

  it('rewrites xpcshell appdir failures with an injection-attempted hint when injection fired', async () => {
    // After auto-injection runs and the xpcshell symptom STILL fires, the
    // diagnostic message must say so — the operator needs to know
    // FireForge already tried the easy fix and the cause lies elsewhere.
    vi.mocked(resolveXpcshellAppdirArg).mockResolvedValueOnce({
      kind: 'injected',
      result: {
        appPath: '/project/engine/obj-debug/dist/bin/browser',
        manifestPath: '/project/engine/x/xpcshell.toml',
        key: 'firefox-appdir',
        relativeAppdir: 'browser',
      },
    });
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toThrow(/auto-injected `--app-path=<absolute>` against the resolved obj-dir/);
  });

  it('keeps the original "Likely triggers" wording when injection did not run', async () => {
    // Default mock returns kind: 'none' — no injection. The diagnostic
    // hint must keep its pre-injection wording so the operator sees the
    // appname-key explanation that points at the underlying upstream
    // behaviour rather than at FireForge's auto-injection path.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: Failed to load resource:///modules/Something.sys.mjs',
    });

    await expect(
      testCommand('/project', ['browser/modules/mybrowser/test/unit/test_something.js'])
    ).rejects.toThrow(/literal `firefox-appdir` directive is silently ignored/);
  });

  // ── --marionette-port option ──────────────────────────────────────────

  it('passes --marionette-port through to the stale-browser probe', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(ensureLaunchableBrowserNotRunning).toHaveBeenCalledWith(
      '/project/engine/obj-debug/dist/bin/firefox',
      { killStaleBrowser: false }
    );
  });

  it('auto-forwards setpref and mochitest --marionette client for browser-chrome paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2912,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--setpref=marionette.port=2912', '--marionette=127.0.0.1:2912']
    );
  });

  it('auto-forwards --setpref=marionette.port=N for toolkit widget HTML paths', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/content/tests/widgets/test_moz-example.html'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/content/tests/widgets/test_moz-example.html'],
      ['--setpref=marionette.port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('auto-forwards --setpref for xpcshell filesystem paths without --flavor=xpcshell', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/components/tests/xpcshell/test_observer.js'], {
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/components/tests/xpcshell/test_observer.js'],
      ['--setpref=marionette.port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('does not auto-forward when the operator already passed the port via --mach-arg', async () => {
    // The forwarded mach-arg is recognised by extractForwardedMarionettePort;
    // the wrapper preflight then targets 2838 too, but the auto-forward must
    // not duplicate the operator's arg in extraArgs.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2838,
        machArg: ['--marionette-port=2838'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--marionette-port=2838', '--marionette=127.0.0.1:2838']
    );
  });

  it('does not add a second --marionette when --mach-arg already sets the client endpoint', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        marionettePort: 2912,
        machArg: ['--marionette=127.0.0.1:2912'],
      })
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['browser/base/content/test/general/browser_focus.js'],
      ['--marionette=127.0.0.1:2912', '--setpref=marionette.port=2912']
    );
  });

  it('parses a forwarded --mach-arg --marionette-port=N as the effective port (no first-class option)', async () => {
    // The documented workaround: operator passes the port via --mach-arg.
    // Pre-fix, the wrapper preflight checked the default 2828 before the
    // forwarded arg ever reached mach. Now extractForwardedMarionettePort
    // surfaces the value to the probe so the workaround actually works.
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        machArg: ['--marionette-port=2838'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
  });

  it('does not auto-forward to mach for an explicit xpcshell flavor', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['toolkit/components/tests/xpcshell/test_observer.js'], {
        marionettePort: 2838,
        machArg: ['--flavor=xpcshell'],
      })
    ).resolves.toBeUndefined();

    expect(assertMarionettePortAvailable).toHaveBeenCalledWith(
      2838,
      expect.objectContaining({ binaryName: 'mybrowser' })
    );
    expect(testWithOutput).toHaveBeenCalledWith(
      '/project/engine',
      ['toolkit/components/tests/xpcshell/test_observer.js'],
      ['--flavor=xpcshell']
    );
  });

  it('passes --marionette-port through to the doctor preflight', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | requested-test\nTEST-OK | requested-test',
      stderr: '',
    });
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: true,
      durationMs: 12_000,
      detail: 'handshake ok',
    });

    await expect(
      testCommand('/project', ['browser/base/content/test/general/browser_focus.js'], {
        doctor: true,
        marionettePort: 2838,
      })
    ).resolves.toBeUndefined();

    expect(runMarionettePreflight).toHaveBeenCalledWith('/project/engine', { port: 2838 });
  });
});

describe('testCommand harness resilience (C1-C4)', () => {
  const GREEN = {
    exitCode: 0,
    stdout: 'TEST-START | requested-test\nTEST-OK | requested-test\nPassed: 3',
    stderr: '',
  };
  const CRASH = {
    exitCode: 1,
    stdout: [
      'Traceback (most recent call last):',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
      'Error running mach',
    ].join('\n'),
    stderr: '',
  };
  const REAL_FAILURE = {
    exitCode: 1,
    stdout:
      'TEST-START | browser_a.js\nTEST-UNEXPECTED-FAIL | browser_a.js | Assertion failed\nFailed: 1',
    stderr: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
    vi.mocked(isSymlink).mockResolvedValue(false);
  });

  it('echoes the verbatim TEST-UNEXPECTED line and assertion text in the failure summary (0.37.0 item 7)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: [
        'TEST-START | browser/components/foo/test/browser_x.js',
        'TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_x.js | Assert.equal - got false, expected true',
        'Got false',
        'Expected true',
        'Unexpected results: 1',
      ].join('\n'),
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_x.js'])
    ).rejects.toThrow(/Tests failed with exit code 1/);

    expect(info).toHaveBeenCalledWith(
      expect.stringContaining(
        'TEST-UNEXPECTED-FAIL | browser/components/foo/test/browser_x.js | Assert.equal - got false, expected true'
      )
    );
    expect(info).toHaveBeenCalledWith(expect.stringContaining('Expected true'));
  });

  it('retries a recognized harness crash and succeeds on a green re-run', async () => {
    vi.mocked(testWithOutput).mockResolvedValueOnce(CRASH).mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Harness crash detected'));
  });

  it('exhausts the default retry budget and reports the harness signature', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(CRASH);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).rejects.toThrow(/crashed in the harness itself.*all 3 attempt/s);

    // Default budget: 2 retries → 3 attempts.
    expect(testWithOutput).toHaveBeenCalledTimes(3);
  });

  it('honours --harness-retries 0 (single attempt, no retry)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(CRASH);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        harnessRetries: 0,
      })
    ).rejects.toThrow(/crashed in the harness itself/);

    expect(testWithOutput).toHaveBeenCalledTimes(1);
  });

  it('appends the caffeinate hint to a headed no-output timeout on macOS (FORGE F17)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'Timed out after 370 seconds with no output',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        harnessRetries: 0,
      })
    ).rejects.toThrow(/caffeinate -dimsu/);
  });

  it('omits the caffeinate hint when the run was headless (FORGE F17)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 1,
      stdout: 'Timed out after 370 seconds with no output',
      stderr: '',
    });

    const failure = await testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
      harnessRetries: 0,
      headless: true,
    }).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/crashed in the harness itself/);
    expect((failure as Error).message).not.toMatch(/caffeinate/);
  });

  it('treats a post-green shutdown re-entry as a harness crash, not a test failure', async () => {
    const shutdownReentry = {
      exitCode: 1,
      stdout: [
        'TEST-START | browser_foo.js',
        'TEST-OK | browser_foo.js',
        'Passed: 12',
        'must wait for focus',
        'TEST-UNEXPECTED-FAIL | browser_foo.js | Application shut down (without crashing) in the middle of a test!',
      ].join('\n'),
      stderr: '',
    };
    vi.mocked(testWithOutput).mockResolvedValueOnce(shutdownReentry).mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledTimes(2);
  });

  it('fails a zero-exit run whose summary shows no TEST-START (silent false green)', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'Passed: 0\nFailed: 0',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).rejects.toThrow(/without starting any of the requested tests/);
  });

  it('shards multi-path requests into sequential single-path invocations', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).resolves.toBeUndefined();

      expect(testWithOutput).toHaveBeenCalledTimes(2);
      expect(vi.mocked(testWithOutput).mock.calls[0]?.[1]).toEqual([
        'browser/components/a/test/browser_a.js',
      ]);
      expect(vi.mocked(testWithOutput).mock.calls[1]?.[1]).toEqual([
        'browser/components/b/test/browser_b.js',
      ]);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('2/2 shard(s) passed'),
        'Sharded Test Summary'
      );
      // FORGE I5: the sharded aggregate ends with the machine-readable verdict.
      expect(writeSpy.mock.calls.map((args) => args[0])).toContain(
        'FIREFORGE-VERDICT: PASS shards=2/2\n'
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('runs every shard, warns per failure, and throws one aggregate error', async () => {
    vi.mocked(testWithOutput).mockResolvedValueOnce(GREEN).mockResolvedValueOnce(REAL_FAILURE);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).rejects.toThrow(/1 of 2 sharded test run\(s\) did not pass: browser\/components\/b/);

      expect(testWithOutput).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tests failed with exit code 1'));
      // FORGE I5: the FAIL aggregate verdict is emitted before the throw.
      expect(writeSpy.mock.calls.map((args) => args[0])).toContain(
        'FIREFORGE-VERDICT: FAIL reason=test-failures shards=1/2\n'
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('--no-shard keeps multiple paths in one combined invocation', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);

    await expect(
      testCommand(
        '/project',
        ['browser/components/a/test/browser_a.js', 'browser/components/b/test/browser_b.js'],
        { shard: false }
      )
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledTimes(1);
    expect(vi.mocked(testWithOutput).mock.calls[0]?.[1]).toEqual([
      'browser/components/a/test/browser_a.js',
      'browser/components/b/test/browser_b.js',
    ]);
  });

  it('--perf-samples publishes the artifact path via <BINARYNAME>_PERF_SAMPLE_JSON', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        perfSamples: 'artifacts/perf-samples.json',
      })
    ).resolves.toBeUndefined();

    const envArg = vi.mocked(testWithOutput).mock.calls[0]?.[3];
    expect(envArg).toEqual({
      MYBROWSER_PERF_SAMPLE_JSON: '/project/artifacts/perf-samples.json',
    });
  });

  it('appends the caffeinate hint to a headed sharded no-output timeout (FORGE F17)', async () => {
    const TIMEOUT_CRASH = {
      exitCode: 1,
      stdout: 'Timed out after 370 seconds with no output',
      stderr: '',
    };
    vi.mocked(testWithOutput).mockResolvedValue(TIMEOUT_CRASH);

    await expect(
      testCommand(
        '/project',
        ['browser/components/a/test/browser_a.js', 'browser/components/b/test/browser_b.js'],
        { harnessRetries: 0 }
      )
    ).rejects.toThrow(/sharded test run\(s\) did not pass/);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('caffeinate -dimsu'));
  });

  it('retries shards independently and reports attempts in the summary', async () => {
    vi.mocked(testWithOutput)
      .mockResolvedValueOnce(GREEN)
      .mockResolvedValueOnce(CRASH)
      .mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', [
        'browser/components/a/test/browser_a.js',
        'browser/components/b/test/browser_b.js',
      ])
    ).resolves.toBeUndefined();

    expect(testWithOutput).toHaveBeenCalledTimes(3);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('(2 attempts)'),
      'Sharded Test Summary'
    );
  });
});

describe('testCommand verdict contract (exactly one FIREFORGE-VERDICT line per run)', () => {
  const GREEN = {
    exitCode: 0,
    stdout: 'TEST-START | requested-test\nTEST-OK | requested-test\nPassed: 3',
    stderr: '',
  };
  const CRASH = {
    exitCode: 1,
    stdout: [
      'Traceback (most recent call last):',
      "AttributeError: 'SystemResourceMonitor' object has no attribute 'poll_interval'",
      'Error running mach',
    ].join('\n'),
    stderr: '',
  };
  const REAL_FAILURE = {
    exitCode: 1,
    stdout:
      'TEST-START | browser_a.js\nTEST-UNEXPECTED-FAIL | browser_a.js | Assertion failed\nFailed: 1',
    stderr: '',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
    vi.mocked(isSymlink).mockResolvedValue(false);
  });

  function captureVerdictLines(): {
    all: () => string[];
    verdicts: () => string[];
    restore: () => void;
  } {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      });
    return {
      all: () => writes,
      verdicts: () => writes.filter((w) => w.startsWith('FIREFORGE-VERDICT:')),
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  it('a missing engine emits exactly one FAIL reason=preflight line', async () => {
    vi.mocked(pathExists).mockResolvedValue(false);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
      ).rejects.toThrow(/Firefox source not found/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);
  });

  it('a missing test path emits exactly one FAIL reason=preflight line', async () => {
    vi.mocked(pathExists).mockImplementation((path: string) =>
      Promise.resolve(path === '/project/engine')
    );

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/components/foo/test/browser_missing.js'])
      ).rejects.toThrow(/run "fireforge import" first/i);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);
  });

  it('a pathless run without a mode emits exactly one FAIL reason=preflight line', async () => {
    const capture = captureVerdictLines();
    try {
      await expect(testCommand('/project', [])).rejects.toThrow(/pathless mode/i);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);
  });

  it('a crashed shard classifies the aggregate as reason=crash, not test-failures (FORGE I7)', async () => {
    vi.mocked(testWithOutput).mockResolvedValueOnce(GREEN).mockResolvedValueOnce(CRASH);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand(
          '/project',
          ['browser/components/a/test/browser_a.js', 'browser/components/b/test/browser_b.js'],
          { harnessRetries: 0 }
        )
      ).rejects.toThrow(/1 of 2 sharded test run\(s\) did not pass/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=crash shards=1/2\n']);
  });

  it('a single failing run emits its classifier verdict once, with no preflight fallback on top', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(REAL_FAILURE);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
      ).rejects.toThrow(/Tests failed with exit code 1/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=test-failures\n']);
  });

  it('a failing doctor preflight emits its reason=preflight line exactly once', async () => {
    vi.mocked(runMarionettePreflight).mockResolvedValue({
      ok: false,
      durationMs: 500,
      detail: 'handshake refused',
    });

    const capture = captureVerdictLines();
    try {
      await expect(testCommand('/project', [], { doctor: true })).rejects.toThrow(
        /Marionette preflight reported FAIL/
      );
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=preflight\n']);
  });
});
