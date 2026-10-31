// SPDX-License-Identifier: EUPL-1.2
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/test-stale-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/test-stale-check.js')>()),
  checkStaleBuildForTest: vi.fn(),
  checkStaticComponentsStale: vi.fn(() => Promise.resolve({ stale: false, changedManifests: [] })),
  findChangedTestManifestsForPaths: vi.fn(() => Promise.resolve([])),
  findCompiledSourcesNewerThanBinary: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('../../core/coverage-dispatch.js', () => ({ filterByCarriedFullCoverage: vi.fn() }));
vi.mock('../test-verdict.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-verdict.js')>()),
  setVerdictRunAttribute: vi.fn(),
}));
vi.mock('../test-perf-scope.js', () => ({
  describePerfStaleImpact: vi.fn(() => Promise.resolve('Perf sample impact: fixture unaffected.')),
}));

import type { BuildBaseline } from '../../core/build-baseline-types.js';
import { filterByCarriedFullCoverage } from '../../core/coverage-dispatch.js';
import {
  checkStaleBuildForTest,
  findCompiledSourcesNewerThanBinary,
  type StaleBuildResult,
} from '../../core/test-stale-check.js';
import { PreflightRefusalError } from '../../errors/base.js';
import { info, warn } from '../../utils/logger.js';
import { describePerfStaleImpact } from '../test-perf-scope.js';
import { enforceStaleBuildGate } from '../test-stale-gate.js';
import { setVerdictRunAttribute } from '../test-verdict.js';

const TEST = 'browser/base/content/test/perf/browser_startup.js';
const BASELINE: BuildBaseline = {
  engineHeadSha: 'abc',
  builtAt: '2026-10-01T00:00:00.000Z',
  binaryName: 'mybrowser',
};

function staleResult(overrides: Partial<StaleBuildResult> = {}): StaleBuildResult {
  return {
    stale: false,
    changedPaths: [],
    truncated: 0,
    baseline: BASELINE,
    ...overrides,
  };
}

async function refusal(promise: Promise<void>): Promise<PreflightRefusalError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof PreflightRefusalError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('enforceStaleBuildGate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(filterByCarriedFullCoverage).mockImplementation((_engine, _baseline, uncovered) =>
      Promise.resolve(uncovered.map((path) => ({ path, changed: [] })))
    );
  });

  it('names edits the runtime already serves without refusing', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ exempt: [{ path: TEST, why: 'symlinked' }] })
    );
    await expect(enforceStaleBuildGate('/p', '/p/engine', {}, [TEST])).resolves.toBeUndefined();
    expect(info).toHaveBeenCalledWith(
      `Stale-build preflight: 1 edit(s) since the last build need no rebuild: ${TEST} (objdir symlink to the source).`
    );
  });

  it('prints the one-line repackaging command in the refusal', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ stale: true, changedPaths: ['browser/base/content/a.js'] })
    );
    const error = await refusal(enforceStaleBuildGate('/p', '/p/engine', {}, [TEST, 'x/test']));
    expect(error.note).toBe('stale-build');
    expect(error.message).toContain(
      `To repackage without running anything: \`fireforge test --build-only ${TEST} x/test\`.`
    );
    expect(describePerfStaleImpact).not.toHaveBeenCalled();

    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ stale: true, changedPaths: ['browser/base/content/a.js'] })
    );
    const pathless = await refusal(enforceStaleBuildGate('/p', '/p/engine', { doctor: true }, []));
    expect(pathless.message).toContain('`fireforge build --ui`');
  });

  it('adds the perf-sample impact to a --perf-samples refusal and warning', async () => {
    const stale = staleResult({ stale: true, changedPaths: ['browser/base/content/a.js'] });
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(stale);
    const error = await refusal(
      enforceStaleBuildGate('/p', '/p/engine', { perfSamples: 'sample.json' }, [TEST])
    );
    expect(error.message).toContain('Perf sample impact: fixture unaffected.');
    expect(describePerfStaleImpact).toHaveBeenCalledWith(
      '/p/engine',
      ['browser/base/content/a.js'],
      [TEST]
    );

    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(stale);
    await enforceStaleBuildGate(
      '/p',
      '/p/engine',
      { perfSamples: 'sample.json', allowStaleBuild: true },
      [TEST]
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Perf sample impact'));
  });

  it('lets a carried full anchor cover a path outside the scoped list', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ baseline: { ...BASELINE, testPackagingCoverage: ['other/test'] } })
    );
    vi.mocked(filterByCarriedFullCoverage).mockResolvedValueOnce([]);
    await expect(enforceStaleBuildGate('/p', '/p/engine', {}, [TEST])).resolves.toBeUndefined();
  });

  it('names the changed staging inputs of a path the carried anchor no longer covers', async () => {
    const fullCoverageAnchor = {
      engineHeadSha: 'abc',
      mozconfigHash: 'a'.repeat(64),
      fingerprints: {},
    };
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({
        baseline: { ...BASELINE, testPackagingCoverage: ['other/test'], fullCoverageAnchor },
      })
    );
    vi.mocked(filterByCarriedFullCoverage).mockResolvedValueOnce([
      { path: TEST, changed: ['browser/base/content/test/perf/head.js'] },
    ]);
    const error = await refusal(enforceStaleBuildGate('/p', '/p/engine', {}, [TEST]));
    expect(error.note).toBe('coverage-replaced');
    expect(error.message).toContain(`${TEST} (browser/base/content/test/perf/head.js)`);
    expect(error.message).toContain('plus earlier full coverage');
    expect(setVerdictRunAttribute).toHaveBeenCalledWith('build-paths', TEST);
  });

  it('names every path the coverage refusal rebuilds as build-paths=, uncapped', async () => {
    const many = Array.from(
      { length: 12 },
      (_, index) => `dom/tests/t${index}/browser_${index}.js`
    );
    const awkward = ['dom/tests/with space/', 'dom\\tests\\win\\browser_w.js', 'dom/tests/a,b%c'];
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ baseline: { ...BASELINE, testPackagingCoverage: ['other/test'] } })
    );
    const error = await refusal(
      enforceStaleBuildGate('/p', '/p/engine', {}, [...many, ...awkward])
    );
    expect(error.note).toBe('coverage-replaced');
    // The prose caps its list; the key does not.
    expect(error.message).toContain('(+');
    expect(setVerdictRunAttribute).toHaveBeenCalledTimes(1);
    const value = vi.mocked(setVerdictRunAttribute).mock.calls[0]?.[1] ?? '';
    expect(value).not.toMatch(/\s/);
    expect(value.split(',').map((entry) => decodeURIComponent(entry))).toEqual([
      ...many,
      'dom/tests/with space',
      'dom/tests/win/browser_w.js',
      'dom/tests/a,b%c',
    ]);
  });

  it('stamps no build-paths= when the whole suite is uncovered', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ baseline: { ...BASELINE, testPackagingCoverage: ['other/test'] } })
    );
    const error = await refusal(enforceStaleBuildGate('/p', '/p/engine', {}, []));
    expect(error.note).toBe('coverage-replaced');
    expect(setVerdictRunAttribute).not.toHaveBeenCalled();
  });

  it('stamps no build-paths= when the request is covered', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({ baseline: { ...BASELINE, testPackagingCoverage: [TEST] } })
    );
    await expect(enforceStaleBuildGate('/p', '/p/engine', {}, [TEST])).resolves.toBeUndefined();
    expect(setVerdictRunAttribute).not.toHaveBeenCalled();
  });
});

describe('stale-compiled and control-built gates', () => {
  const STALE_COMPILED = {
    paths: ['gfx/layers/apz/src/AsyncPanZoomController.cpp'],
    linkedPath: 'obj-x/dist/bin/libxul.so',
    linkedAt: new Date('2026-10-20T14:29:34.000Z'),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(filterByCarriedFullCoverage).mockResolvedValue([]);
  });

  it('refuses compiled sources newer than the binary, naming them', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(staleResult());
    vi.mocked(findCompiledSourcesNewerThanBinary).mockResolvedValueOnce(STALE_COMPILED);
    const error = await refusal(
      enforceStaleBuildGate('/p', '/p/engine', {}, [TEST], {
        launchablePath: 'obj-x/dist/bin/mybrowser',
      })
    );
    expect(error.note).toBe('stale-compiled');
    expect(error.message).toContain('engine/gfx/layers/apz/src/AsyncPanZoomController.cpp');
    expect(findCompiledSourcesNewerThanBinary).toHaveBeenCalledWith(
      '/p/engine',
      BASELINE,
      'obj-x/dist/bin/mybrowser'
    );
  });

  it('downgrades the stale-compiled refusal to a warning under --allow-stale-build', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(staleResult());
    vi.mocked(findCompiledSourcesNewerThanBinary).mockResolvedValueOnce(STALE_COMPILED);
    await expect(
      enforceStaleBuildGate('/p', '/p/engine', { allowStaleBuild: true }, [TEST])
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('AsyncPanZoomController.cpp'));
  });

  it('refuses a binary a negative control was compiled into, even with --allow-stale-build', async () => {
    vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(
      staleResult({
        baseline: {
          ...BASELINE,
          controlBuild: {
            diffFile: 'controls/first-key.diff',
            targets: ['gfx/layers/apz/src/APZCTreeManager.cpp'],
            appliedAt: '2026-10-22T10:00:00.000Z',
          },
        },
      })
    );
    const error = await refusal(
      enforceStaleBuildGate('/p', '/p/engine', { allowStaleBuild: true }, [TEST])
    );
    expect(error.note).toBe('control-built');
    expect(error.message).toContain('controls/first-key.diff');
    expect(error.message).toContain('"fireforge build"');
  });

  describe("an invocation's own control build", () => {
    const TARGET = 'gfx/wr/webrender/src/renderer/mod.rs';
    const STAMP = {
      diffFile: 'controls/934-revert.diff',
      targets: [TARGET, 'gfx/wr/webrender/src/picture.rs'],
      appliedAt: '2026-10-26T09:00:00.000Z',
    };
    const STAMPED = staleResult({ baseline: { ...BASELINE, controlBuild: STAMP } });
    const LAUNCHABLE = 'obj-x/dist/bin/mybrowser';

    it('lets a later --repeat run test the binary its own control build stamped', async () => {
      vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(STAMPED);
      // The restore after run 1 left the control's targets newer than the binary.
      vi.mocked(findCompiledSourcesNewerThanBinary).mockResolvedValueOnce({
        ...STALE_COMPILED,
        paths: [...STAMP.targets],
      });
      await expect(
        enforceStaleBuildGate('/p', '/p/engine', {}, [TEST], {
          launchablePath: LAUNCHABLE,
          ownControlBuild: { ...STAMP },
        })
      ).resolves.toBeUndefined();
    });

    it('still refuses other compiled sources newer than that binary', async () => {
      vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(STAMPED);
      vi.mocked(findCompiledSourcesNewerThanBinary).mockResolvedValueOnce({
        ...STALE_COMPILED,
        paths: [TARGET, ...STALE_COMPILED.paths],
      });
      const error = await refusal(
        enforceStaleBuildGate('/p', '/p/engine', {}, [TEST], {
          launchablePath: LAUNCHABLE,
          ownControlBuild: STAMP,
        })
      );
      expect(error.note).toBe('stale-compiled');
      expect(error.message).toContain('engine/gfx/layers/apz/src/AsyncPanZoomController.cpp');
      expect(error.message).not.toContain(TARGET);
    });

    it('refuses a stamp another control build wrote', async () => {
      for (const other of [
        { ...STAMP, appliedAt: '2026-10-26T08:00:00.000Z' },
        { ...STAMP, diffFile: 'controls/other.diff' },
      ]) {
        vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(STAMPED);
        const error = await refusal(
          enforceStaleBuildGate('/p', '/p/engine', {}, [TEST], {
            launchablePath: LAUNCHABLE,
            ownControlBuild: other,
          })
        );
        expect(error.note).toBe('control-built');
      }
    });

    it('keeps refusing the control files when the control build recorded no stamp', async () => {
      vi.mocked(checkStaleBuildForTest).mockResolvedValueOnce(staleResult());
      vi.mocked(findCompiledSourcesNewerThanBinary).mockResolvedValueOnce({
        ...STALE_COMPILED,
        paths: [TARGET],
      });
      const error = await refusal(
        enforceStaleBuildGate('/p', '/p/engine', {}, [TEST], {
          launchablePath: LAUNCHABLE,
          ownControlBuild: STAMP,
        })
      );
      expect(error.note).toBe('stale-compiled');
    });
  });
});
