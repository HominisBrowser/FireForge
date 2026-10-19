// SPDX-License-Identifier: EUPL-1.2
/**
 * The pre-test build's kind: `mach build faster` by default, a full
 * `mach build` when a jar.mn registration or a compiled negative control
 * needs one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../../core/build-baseline.js', () => ({
  readBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
  writeBuildBaseline: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/build-prepare.js', () => ({
  prepareBuildEnvironment: vi.fn(() =>
    Promise.resolve({ furnaceApplied: 0, reconfigured: false, fullBuildRequired: false })
  ),
}));
vi.mock('../../core/coverage-extend.js', () => ({
  applyMozconfigAnchor: vi.fn((_engine: string, plan: unknown) => Promise.resolve(plan)),
  formatCoverageRetentionNotice: vi.fn(() => undefined),
  formatExtendCoverageRefusal: vi.fn(() => ''),
  planCoverageRetention: vi.fn(() =>
    Promise.resolve({ keepFull: false, retained: {}, dropped: [] })
  ),
  recordScopedCoverage: vi.fn((_engine: string, _plan: unknown, coverage: unknown) =>
    Promise.resolve({ testPackagingCoverage: coverage })
  ),
}));
vi.mock('../../core/mach.js', () => ({
  hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: undefined })),
  runProtectedMachBuild: vi.fn(() => Promise.resolve({ exitCode: 0, attempts: 1 })),
  withBuildLock: vi.fn((_root: string, body: () => Promise<void>) => body()),
}));
vi.mock('../../core/objdir-maintenance.js', () => ({
  assertHealthyPartialConfig: vi.fn(() => Promise.resolve()),
  pruneDanglingTestLinks: vi.fn(() => Promise.resolve(0)),
}));
vi.mock('../test-build-furnace.js', () => ({
  reportPreTestFurnace: vi.fn(() => Promise.resolve()),
}));
vi.mock('../test-furnace-reach.js', () => ({
  partitionReachedComponents: vi.fn(() => Promise.resolve({ reached: [], skipped: [] })),
  resolveFurnaceApplyMode: vi.fn(() => 'all'),
}));
vi.mock('../test-stale-gate.js', () => ({
  enforceStaleBuildGate: vi.fn(() => Promise.resolve()),
  enforceStaticComponentsGate: vi.fn(() => Promise.resolve()),
}));

import { writeBuildBaseline } from '../../core/build-baseline.js';
import { runProtectedMachBuild } from '../../core/mach.js';
import type { FireForgeConfig, ProjectPaths } from '../../types/config.js';
import { notice } from '../../utils/logger.js';
import { runTestBuildPhase } from '../test-build-phase.js';

const PATHS = { engine: '/project/engine' } as ProjectPaths;
const CONFIG = { binaryName: 'mybrowser' } as FireForgeConfig;
const REQUEST = {
  classification: { xpcshell: [], nonXpcshell: ['browser/base/content/test/a/browser_a.js'] },
  normalizedPaths: ['browser/base/content/test/a/browser_a.js'],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('runTestBuildPhase', () => {
  it('runs mach build faster by default', async () => {
    await runTestBuildPhase('/project', PATHS, CONFIG, 0, { build: true }, REQUEST);
    expect(runProtectedMachBuild).toHaveBeenCalledWith('faster', PATHS.engine, expect.anything());
  });

  it('escalates to a full build when the run asks for one (a compiled negative control)', async () => {
    const reason = 'The negative control edits compiled source (engine/gfx/a.cpp); escalating.';
    await runTestBuildPhase(
      '/project',
      PATHS,
      CONFIG,
      0,
      { build: true },
      {
        ...REQUEST,
        fullBuildReason: reason,
      }
    );
    expect(runProtectedMachBuild).toHaveBeenCalledWith('full', PATHS.engine, expect.anything());
    expect(notice).toHaveBeenCalledWith(reason);
    expect(writeBuildBaseline).toHaveBeenCalledWith(
      expect.objectContaining({ buildKind: 'full', staticComponentsHandling: 'refresh' })
    );
  });
});
