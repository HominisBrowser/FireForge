// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The run log is opened before any preflight and its path rides the
// FIREFORGE-VERDICT line as ` log=<path>`, so these exact-string verdict
// assertions require no log to be open. Stating that here replaces the
// accident they used to rely on: `/project` is a filesystem root on POSIX,
// so the best-effort open failed and degraded to "no log". On Windows the
// same path resolves against the current drive and succeeds.
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
// src/core/__tests__/coverage-extend.test.ts). Here the command-level
// contract is what the command does with each verdict, so the probes are
// mocked and the union stays real.
vi.mock('../../core/coverage-extend.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).coverageExtendMock(importOriginal)
);

// Default to the pass-through analysis (file args, no siblings) so every
// existing dispatch assertion stays valid. The directory-scope tests
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

// The in-tree objdir/marker cross-check is a pass-through by default. The
// dedicated test drives its refusal. Real behavior is covered in
// tree-store.integration.test.ts.
vi.mock('../../core/tree-store.js', async () =>
  (await import('./test-command-mocks.js')).treeStoreMock()
);

import {} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  runMachTestSuite,
} from '../../core/mach.js';
import {} from '../../core/marionette-port.js';
import {} from '../../core/marionette-preflight.js';
import {} from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { nativeAbsPath } from '../../test-utils/index.js';
import { isSymlink, pathExists } from '../../utils/fs.js';
import { info, note, warn } from '../../utils/logger.js';
import { testCommand } from '../test.js';

// Harness resilience (C1-C4), split out of `test.test.ts`. The shared
// `vi.mock` header comes from `test-command-mocks.ts`.
describe('testCommand harness resilience', () => {
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

  it('echoes the verbatim TEST-UNEXPECTED line and assertion text in the failure summary', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue({
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
    vi.mocked(runMachTestSuite).mockResolvedValueOnce(CRASH).mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).resolves.toBeUndefined();

    expect(runMachTestSuite).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Harness crash detected'));
  });

  it('exhausts the default retry budget and reports the harness signature', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(CRASH);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).rejects.toThrow(/crashed in the harness itself.*all 3 attempt/s);

    // Default budget: 2 retries → 3 attempts.
    expect(runMachTestSuite).toHaveBeenCalledTimes(3);
  });

  it('honours --harness-retries 0 (single attempt, no retry)', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(CRASH);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        harnessRetries: 0,
      })
    ).rejects.toThrow(/crashed in the harness itself/);

    expect(runMachTestSuite).toHaveBeenCalledTimes(1);
  });

  // The hint used to recommend `caffeinate`, which prevents sleep and
  // cannot wake an already-sleeping display, so it could not have cured the
  // incident it was recommended for. It now prints the three-cause triage
  // list for this exact signature.
  it('appends the no-output-stall triage list to a headed timeout on macOS', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue({
      exitCode: 1,
      stdout: 'Timed out after 370 seconds with no output',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        harnessRetries: 0,
      })
    ).rejects.toThrow(/sleeping or locked display/);
  });

  it('omits the caffeinate hint when the run was headless', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue({
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
    vi.mocked(runMachTestSuite).mockResolvedValueOnce(shutdownReentry).mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).resolves.toBeUndefined();

    expect(runMachTestSuite).toHaveBeenCalledTimes(2);
  });

  it('fails a zero-exit run whose summary shows no TEST-START (silent false green)', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue({
      exitCode: 0,
      stdout: 'Passed: 0\nFailed: 0',
      stderr: '',
    });

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
    ).rejects.toThrow(/without starting any of the requested tests/);
  });

  it('shards multi-path requests into sequential single-path invocations', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).resolves.toBeUndefined();

      expect(runMachTestSuite).toHaveBeenCalledTimes(2);
      expect(vi.mocked(runMachTestSuite).mock.calls[0]?.[1]?.testPaths).toEqual([
        'browser/components/a/test/browser_a.js',
      ]);
      expect(vi.mocked(runMachTestSuite).mock.calls[1]?.[1]?.testPaths).toEqual([
        'browser/components/b/test/browser_b.js',
      ]);
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining('2/2 shard(s) passed'),
        'Sharded Test Summary'
      );
      // The sharded aggregate ends with the machine-readable verdict.
      expect(writeSpy.mock.calls.map((args) => args[0])).toContain(
        'FIREFORGE-VERDICT: PASS shards=2/2\n'
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('runs every shard, warns per failure, and throws one aggregate error', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValueOnce(GREEN).mockResolvedValueOnce(REAL_FAILURE);

    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).rejects.toThrow(/1 of 2 sharded test run\(s\) did not pass: browser\/components\/b/);

      expect(runMachTestSuite).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Tests failed with exit code 1'));
      // The FAIL aggregate verdict is emitted before the throw.
      expect(writeSpy.mock.calls.map((args) => args[0])).toContain(
        'FIREFORGE-VERDICT: FAIL reason=test-failures shards=1/2\n'
      );
    } finally {
      writeSpy.mockRestore();
    }
  });

  it('--no-shard keeps multiple paths in one combined invocation', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    await expect(
      testCommand(
        '/project',
        ['browser/components/a/test/browser_a.js', 'browser/components/b/test/browser_b.js'],
        { shard: false }
      )
    ).resolves.toBeUndefined();

    expect(runMachTestSuite).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runMachTestSuite).mock.calls[0]?.[1]?.testPaths).toEqual([
      'browser/components/a/test/browser_a.js',
      'browser/components/b/test/browser_b.js',
    ]);
  });

  it('--perf-samples publishes the artifact path via <BINARYNAME>_PERF_SAMPLE_JSON', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(GREEN);

    await expect(
      testCommand('/project', ['browser/components/foo/test/browser_foo.js'], {
        perfSamples: 'artifacts/perf-samples.json',
      })
    ).resolves.toBeUndefined();

    const envArg = vi.mocked(runMachTestSuite).mock.calls[0]?.[1]?.env;
    expect(envArg).toEqual({
      MYBROWSER_PERF_SAMPLE_JSON: nativeAbsPath('/project/artifacts/perf-samples.json'),
    });
  });

  it('appends the no-output-stall triage list to a headed sharded timeout', async () => {
    const TIMEOUT_CRASH = {
      exitCode: 1,
      stdout: 'Timed out after 370 seconds with no output',
      stderr: '',
    };
    vi.mocked(runMachTestSuite).mockResolvedValue(TIMEOUT_CRASH);

    await expect(
      testCommand(
        '/project',
        ['browser/components/a/test/browser_a.js', 'browser/components/b/test/browser_b.js'],
        { harnessRetries: 0 }
      )
    ).rejects.toThrow(/sharded test run\(s\) did not pass/);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('sleeping or locked display'));
  });

  it('retries shards independently and reports attempts in the summary', async () => {
    vi.mocked(runMachTestSuite)
      .mockResolvedValueOnce(GREEN)
      .mockResolvedValueOnce(CRASH)
      .mockResolvedValueOnce(GREEN);

    await expect(
      testCommand('/project', [
        'browser/components/a/test/browser_a.js',
        'browser/components/b/test/browser_b.js',
      ])
    ).resolves.toBeUndefined();

    expect(runMachTestSuite).toHaveBeenCalledTimes(3);
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining('(2 attempts)'),
      'Sharded Test Summary'
    );
  });
});
