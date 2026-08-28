// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

import {} from '../../core/coverage-extend.js';
import {
  buildArtifactMismatchMessage,
  hasBuildArtifacts,
  testWithOutput,
} from '../../core/mach.js';
import {} from '../../core/marionette-port.js';
import { runMarionettePreflight } from '../../core/marionette-preflight.js';
import {} from '../../core/test-stale-check.js';
import { findNearestXpcshellManifest } from '../../core/xpcshell-appdir.js';
import { isSymlink, pathExists } from '../../utils/fs.js';
import { testCommand } from '../test.js';

// The one-verdict-line-per-run contract, split out of `test.test.ts` —
// the shared `vi.mock` header comes from `test-command-mocks.ts`.
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

  it('a crashed shard classifies the aggregate as reason=crash, not test-failures', async () => {
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
