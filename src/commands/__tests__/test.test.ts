// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The run log is opened before any preflight and its path rides the
// FIREFORGE-VERDICT line as ` log=<path>`, so these exact-string verdict
// assertions require no log to be open. Stating that here replaces the
// accident they used to rely on: `/project` is a filesystem root on POSIX,
// so the best-effort open failed and degraded to "no log" — while on
// Windows the same path resolves against the current drive and succeeds.
vi.mock('../../core/run-log.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createRunLogMock()
);

vi.mock('../../core/config.js', async () => (await import('./test-command-mocks.js')).configMock());

vi.mock('../../core/mach.js', async () => (await import('./test-command-mocks.js')).machMock());

vi.mock('../../core/build-prepare.js', async () =>
  (await import('./test-command-mocks.js')).buildPrepareMock()
);

vi.mock('../../core/build-baseline.js', async () =>
  (await import('./test-command-mocks.js')).buildBaselineMock()
);

// The --extend-coverage anchor probes real git/file state (covered by
// src/core/__tests__/coverage-extend.test.ts); here the command-level
// contract is what the command does with each verdict, so the probes are
// mocked and the union stays real.
vi.mock('../../core/coverage-extend.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).coverageExtendMock(importOriginal)
);

// Default to the pass-through analysis (file args, no siblings) so every
// existing dispatch assertion stays valid; the directory-scope tests
// override per case. formatScopeNotice stays real so notice assertions
// pin the actual wording. The fs-walking analysis itself is covered by
// src/core/__tests__/test-path-scope.test.ts.
vi.mock('../../core/test-path-scope.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testPathScopeMock(importOriginal)
);

vi.mock('../../utils/fs.js', async () => (await import('./test-command-mocks.js')).fsMock());

vi.mock('../../utils/logger.js', async () =>
  (await import('./test-command-mocks.js')).loggerMock()
);

vi.mock('../../utils/platform.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).platformMock(importOriginal)
);

vi.mock('../../core/marionette-preflight.js', async () =>
  (await import('./test-command-mocks.js')).marionettePreflightMock()
);

// Default to "port is free" so every existing test case proceeds
// through the probe to the mach invocation. The dedicated port-probe
// tests in `src/core/__tests__/marionette-port.test.ts` exercise the
// holder detection and error shape in isolation.
vi.mock('../../core/marionette-port.js', async () =>
  (await import('./test-command-mocks.js')).marionettePortMock()
);

// Partial mock: the probes and warning copy stay stubbed, but the pure
// coverage helpers (`findUncoveredRequestPaths`, `formatTestCoverageRefusal`,
// `formatStaticComponentsRefusal`) run real so the refusal tests pin the
// actual matcher semantics and message wording through the command.
vi.mock('../../core/test-stale-check.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testStaleCheckMock(importOriginal)
);

vi.mock('../../core/xpcshell-appdir.js', async () =>
  (await import('./test-command-mocks.js')).xpcshellAppdirMock()
);

// The in-tree objdir/marker cross-check is a pass-through by default; the
// dedicated test drives its refusal. Real behavior is covered in
// tree-store.integration.test.ts.
vi.mock('../../core/tree-store.js', async () =>
  (await import('./test-command-mocks.js')).treeStoreMock()
);

import { writeBuildBaseline } from '../../core/build-baseline.js';
import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import { loadConfig } from '../../core/config.js';
import {} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  runProtectedMachBuild,
  testWithOutput,
  withBuildLock,
} from '../../core/mach.js';
import {} from '../../core/marionette-port.js';
import {
  reportMarionettePreflight,
  runMarionettePreflight,
} from '../../core/marionette-preflight.js';
import { analyzeTestPathScopes } from '../../core/test-path-scope.js';
import {} from '../../core/test-stale-check.js';
import { assertObjdirMatchesTreeMarker } from '../../core/tree-store.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { GeneralError } from '../../errors/base.js';
import { AmbiguousBuildArtifactsError, BuildError } from '../../errors/build.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { info, notice, outro, success } from '../../utils/logger.js';
import { testCommand } from '../test.js';

// Suite 1 of 6 for `fireforge test`: discovery, failure-message rewriting,
// build gating, the canary verdict, and harness dispatch/sharding. The
// siblings — `test-staleness-coverage`, `test-xpcshell-appdir`,
// `test-marionette-forwarding`, `test-harness-resilience` and
// `test-verdict-contract` — share this header through
// `test-command-mocks.ts`.
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

  it('routes fork-module load failures to the module-registration hint', async () => {
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
      'refresh',
      'full'
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
      // The canary path ends with the machine-readable verdict.
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

      // The FAIL verdict line is emitted before the throw
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

  // The pre-test --build routes through the protected mach dispatch:
  // in-venv guard plus uniform crash retries.

  it('proceeds to tests when the protected pre-test build recovered via retry', async () => {
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

  it('forwards --harness-retries into the protected pre-test build and reports an exhausted crash budget', async () => {
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

  it('treats a green embedded summary with a non-zero exit as a pass', async () => {
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
        // crash green-wash rejection is for.
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

  it('sharded green runs with degradation noise pass instead of reporting CRASH', async () => {
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

  it('announces per-file sharding and points at --no-shard', async () => {
    vi.mocked(testWithOutput).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nUnexpected results: 0\nSUITE_END',
      stderr: '',
    });

    await testCommand('/project', [
      'browser/components/tests/unit/test_one.js',
      'browser/components/tests/unit/test_two.js',
    ]);

    // The sharding notice is emitted at warning severity so an agent
    // output filter cannot drop the line that says what the default did
    // and did not exercise.
    expect(notice).toHaveBeenCalledWith(
      expect.stringContaining('Cross-argument state is NOT exercised — pass --no-shard')
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('running 2 test path arguments'));
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
    // mach's string-prefix match means `…/test/hominis` also runs the
    // sibling `…/test/hominis-tiles`, and a trailing-slash form does NOT
    // stop it. The dispatch must be the enumerated explicit file list, which
    // cannot prefix-match a sibling, in a single mach invocation so
    // cross-file state still carries within the directory.
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
      // The doctor-only success path writes the PASS line via
      // `process.stdout.write` so non-TTY captures always see the summary.
      // This test runs with `isTTY: false`, so that raw write is the ONLY
      // emission — a redundant `success()` call would make the same line
      // appear three times on a terminal.
      expect(success).not.toHaveBeenCalled();
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
      // Doctor-only runs end with the machine-readable verdict.
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
});
