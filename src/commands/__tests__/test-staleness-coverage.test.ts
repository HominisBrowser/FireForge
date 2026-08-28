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

import { readBuildBaseline, writeBuildBaseline } from '../../core/build-baseline.js';
import { prepareBuildEnvironment } from '../../core/build-prepare.js';
import {
  checkExtendCoverageAnchor,
  checkExtendMozconfigAnchor,
} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  runProtectedMachBuild,
  testWithOutput,
  xpcshellTestWithOutput,
} from '../../core/mach.js';
import {} from '../../core/marionette-port.js';
import { runMarionettePreflight } from '../../core/marionette-preflight.js';
import {
  checkStaleBuildForTest,
  checkStaticComponentsStale,
  formatStaleBuildWarning,
} from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { GeneralError } from '../../errors/base.js';
import { isSymlink, pathExists, removeFile } from '../../utils/fs.js';
import { info, warn } from '../../utils/logger.js';
import { testCommand } from '../test.js';

// The stale-build and packaging-coverage gates, plus the --build-only /
// --extend-coverage union claims. Split out of `test.test.ts`; the shared
// `vi.mock` header comes from `test-command-mocks.ts`.
describe('testCommand staleness and packaging coverage', () => {
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

  // A green pre-test build refreshes the stale-build baseline exactly like
  // `fireforge build` does, so any later plain `fireforge test` invocation
  // shape over the same files passes the gate.

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

  // Every non---build run is refused when the packaged runtime does not
  // cover it, instead of dispatching into a fixture hang;
  // --allow-stale-build only accepts stale content.

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

  it('treats a baseline without testPackagingCoverage as full coverage', async () => {
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

  // Coverage is manifest-granular: a scoped rebuild stages the whole
  // manifest directory, so a same-manifest sibling of a covered file must
  // pass the coverage gate.

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

  // components.conf registrations bake into the compiled StaticComponents
  // table that only a FULL build regenerates — refuse runs that would
  // resolve the old table.

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

  describe('--build-only union build', () => {
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

  describe('--extend-coverage union claim', () => {
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

  describe('--refuse-unexported-drift', () => {
    const SLICE = 'browser/base/content/test/b/browser_b.js';

    it('forwards the refusal to the pre-test build', async () => {
      await testCommand('/project', [SLICE], { build: true, refuseUnexportedDrift: true });
      expect(prepareBuildEnvironment).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ refuseUnexportedDrift: true })
      );
    });

    it('leaves the pre-test build warning-only when the flag is absent', async () => {
      await testCommand('/project', [SLICE], { build: true });
      expect(prepareBuildEnvironment).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ refuseUnexportedDrift: false })
      );
    });

    it('is refused without --build/--build-only, which dispatches no build to guard', async () => {
      await expect(
        testCommand('/project', [SLICE], { refuseUnexportedDrift: true })
      ).rejects.toThrow(/--refuse-unexported-drift requires --build or --build-only/);
    });
  });
});
