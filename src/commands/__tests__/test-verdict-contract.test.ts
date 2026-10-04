// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleTestHost, stampPerfHost } from '../../core/test-host-state.js';

// The run log is opened before any preflight and its path rides the
// FIREFORGE-VERDICT line as ` log=<path>`, so these exact-string verdict
// assertions require no log to be open. Stating that here replaces the
// accident they used to rely on: `/project` is a filesystem root on POSIX,
// so the best-effort open failed and degraded to "no log". On Windows the
// same path resolves against the current drive and succeeds.
vi.mock('../../core/test-host-state.js', () => ({
  sampleTestHost: vi.fn(() => Promise.resolve({ load: 0, power: 'unknown' })),
  reportTestHost: vi.fn(() => false),
  stampPerfHost: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('../../core/test-profile-files.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/test-profile-files.js')>()),
  stageProfileFiles: vi.fn(() =>
    Promise.resolve({ root: '/tmp/staged-profile', args: [], env: {} })
  ),
  cleanupProfileFiles: vi.fn(() => Promise.resolve()),
}));
vi.mock('../test-harness-teardown.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-harness-teardown.js')>()),
  removePgidFile: vi.fn(() => Promise.resolve()),
}));

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
import { runMarionettePreflight } from '../../core/marionette-preflight.js';
import { closeActiveRunLog } from '../../core/run-log.js';
import { cleanupProfileFiles } from '../../core/test-profile-files.js';
import {} from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { isSymlink, pathExists } from '../../utils/fs.js';
import { testCommand } from '../test.js';
import { removePgidFile } from '../test-harness-teardown.js';

// The one-verdict-line-per-run contract, split out of `test.test.ts`. The
// shared `vi.mock` header comes from `test-command-mocks.ts`.
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
    vi.mocked(cleanupProfileFiles).mockReset().mockResolvedValue(undefined);
    vi.mocked(removePgidFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(closeActiveRunLog).mockReset().mockResolvedValue(undefined);
    vi.mocked(sampleTestHost).mockResolvedValue({ load: 0, power: 'unknown' });
    vi.mocked(stampPerfHost).mockReset().mockResolvedValue(false);
    vi.mocked(pathExists).mockResolvedValue(true);
    vi.mocked(hasBuildArtifacts).mockResolvedValue({ exists: true, objDir: 'obj-debug' });
    vi.mocked(buildArtifactMismatchMessage).mockReturnValue(undefined);
    vi.mocked(findNearestXpcshellManifest).mockResolvedValue(null);
    vi.mocked(isSymlink).mockResolvedValue(false);
  });

  it.each([false, true])(
    'runs all cleanup without replacing the harness result (failure=%s)',
    async (failure) => {
      vi.mocked(cleanupProfileFiles).mockRejectedValueOnce(new Error('profile cleanup denied'));
      vi.mocked(removePgidFile).mockRejectedValueOnce(new Error('PGID cleanup denied'));
      vi.mocked(closeActiveRunLog).mockRejectedValueOnce(new Error('log cleanup denied'));
      vi.mocked(runMachTestSuite).mockResolvedValue(failure ? REAL_FAILURE : GREEN);
      const capture = captureVerdictLines();
      try {
        const run = testCommand('/project', ['browser/test/browser_a.js'], {
          profileFile: ['sheet.css=chrome/userChrome.css'],
          pgidFile: '/tmp/test.pgid',
        });
        if (failure) await expect(run).rejects.toThrow(/Tests failed/);
        else await expect(run).resolves.toBeUndefined();
        expect(cleanupProfileFiles).toHaveBeenCalledWith('/tmp/staged-profile');
        expect(removePgidFile).toHaveBeenCalledWith('/tmp/test.pgid');
        expect(closeActiveRunLog).toHaveBeenCalled();
        expect(capture.verdicts()).toHaveLength(1);
        expect(capture.verdicts()[0]).toContain(failure ? 'FAIL reason=test-failures' : 'PASS');
      } finally {
        capture.restore();
      }
    }
  );

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

  it('refuses a perf sample with a power transition even when every harness assertion passed', async () => {
    vi.mocked(sampleTestHost).mockResolvedValue({ load: 2, power: 'ac' });
    vi.mocked(stampPerfHost).mockResolvedValueOnce(true);
    vi.mocked(runMachTestSuite).mockResolvedValue({
      exitCode: 0,
      stdout: 'TEST-START | t\nTEST-OK | t',
      stderr: '',
    });
    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/base/content/test/tiles/browser_test.js'], {
          perfSamples: 'sample.json',
        })
      ).rejects.toThrow(/power source changed/i);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toHaveLength(1);
    expect(capture.verdicts()[0]).toContain('FAIL reason=inconclusive');
    expect(capture.verdicts()[0]).toContain('power-source=ac');
    expect(capture.verdicts()[0]).toContain('power-changed=true');
    vi.mocked(sampleTestHost).mockResolvedValue({ load: 0, power: 'unknown' });
  });

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

  it('a crashed shard classifies the aggregate as reason=crash, not test-failures', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValueOnce(GREEN).mockResolvedValueOnce(CRASH);

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
    expect(capture.verdicts()).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=crash shards=1/2 host-load=0.00\n',
    ]);
  });

  it('a single failing run emits its classifier verdict once, with no preflight fallback on top', async () => {
    vi.mocked(runMachTestSuite).mockResolvedValue(REAL_FAILURE);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/components/foo/test/browser_foo.js'])
      ).rejects.toThrow(/Tests failed with exit code 1/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual([
      'FIREFORGE-VERDICT: FAIL reason=test-failures host-load=0.00\n',
    ]);
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
