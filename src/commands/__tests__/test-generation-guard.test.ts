// SPDX-License-Identifier: EUPL-1.2
/**
 * Command-level tests for the engine-generation guard's verdict ordering
 *: a run invalidated by a concurrent `engine/` mutation must
 * emit `FAIL reason=inconclusive` as its single verdict line — the sharded
 * aggregate `PASS shards=N/N` must never print first, and single runs must
 * not end verdict-less. Kept separate from `test.test.ts`, which
 * deliberately leaves `engine-session-lock.js` unmocked (its probes fail
 * against the fake `/project/engine` and take the warn-only branch).
 */
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
  const captureDispatch = vi.fn();
  return {
    hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
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

vi.mock('../../core/engine-session-lock.js', () => ({
  snapshotEngineGeneration: vi.fn(() => Promise.resolve('generation-before')),
  assertEngineGenerationUnchanged: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../core/build-baseline.js', () => ({
  readBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
  writeBuildBaseline: vi.fn(() => Promise.resolve()),
}));

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
  pathExists: vi.fn(() => Promise.resolve(true)),
  isSymlink: vi.fn(() => Promise.resolve(false)),
  removeFile: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/logger.js', () => ({
  setStdoutSealed: vi.fn(),
  intro: vi.fn(),
  info: vi.fn(),
  note: vi.fn(),
  notice: vi.fn(),
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

vi.mock('../../core/marionette-port.js', async () => {
  const actual = await vi.importActual<typeof import('../../core/marionette-port.js')>(
    '../../core/marionette-port.js'
  );
  return {
    ...actual,
    assertMarionettePortAvailable: vi.fn(() => Promise.resolve()),
    ensureMarionettePortAvailable: vi.fn(() => Promise.resolve()),
    probeMarionettePort: vi.fn(() => Promise.resolve({ inUse: false })),
  };
});

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

vi.mock('../../core/tree-store.js', () => ({
  assertObjdirMatchesTreeMarker: vi.fn(() => Promise.resolve()),
}));

import { assertEngineGenerationUnchanged } from '../../core/engine-session-lock.js';
import { testWithOutput } from '../../core/mach.js';
import { GeneralError } from '../../errors/base.js';
import { testCommand } from '../test.js';

const GREEN = {
  exitCode: 0,
  stdout: 'TEST-START | requested-test\nTEST-OK | requested-test\nPassed: 3',
  stderr: '',
};

const GENERATION_ERROR = new GeneralError(
  'engine/ changed while `fireforge test` was running — the verdict is invalid/inconclusive.'
);

function captureVerdictLines(): { verdicts: () => string[]; restore: () => void } {
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

describe('engine-generation guard verdict ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(assertEngineGenerationUnchanged).mockResolvedValue();
  });

  it('a green sharded run whose engine mutated emits FAIL reason=inconclusive, never PASS shards=', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);
    vi.mocked(assertEngineGenerationUnchanged).mockRejectedValue(GENERATION_ERROR);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).rejects.toThrow(/engine\/ changed/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=inconclusive\n']);
  });

  it('a green single run whose engine mutated emits FAIL reason=inconclusive instead of nothing', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);
    vi.mocked(assertEngineGenerationUnchanged).mockRejectedValue(GENERATION_ERROR);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', ['browser/components/a/test/browser_a.js'])
      ).rejects.toThrow(/engine\/ changed/);
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: FAIL reason=inconclusive\n']);
  });

  it('an unchanged engine leaves the sharded aggregate verdict intact', async () => {
    vi.mocked(testWithOutput).mockResolvedValue(GREEN);

    const capture = captureVerdictLines();
    try {
      await expect(
        testCommand('/project', [
          'browser/components/a/test/browser_a.js',
          'browser/components/b/test/browser_b.js',
        ])
      ).resolves.toBeUndefined();
    } finally {
      capture.restore();
    }
    expect(capture.verdicts()).toEqual(['FIREFORGE-VERDICT: PASS shards=2/2\n']);
    // The guard ran before the verdict was emitted.
    expect(assertEngineGenerationUnchanged).toHaveBeenCalledWith(
      '/project/engine',
      'generation-before'
    );
  });
});
