// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared `vi.mock` factories for the `fireforge test` command suites.
 *
 * Carrying these ~190 lines inline in one suite makes splitting it a choice
 * between duplicating the whole header into every new file or not splitting
 * at all. Each factory is called from inside the consuming file's own
 * `vi.mock` callback, so hoisting is unaffected and every suite still gets
 * its own fresh `vi.fn()`s rather than sharing call history.
 *
 * Module specifiers are written relative to `src/commands/__tests__/`, the
 * directory this file shares with its consumers.
 */

import { vi } from 'vitest';

/** Vitest's `importOriginal` callback, typed so the generic call form works. */
type ImportOriginal = <T = unknown>() => Promise<T>;

/**
 * What a `vi.mock` factory returns: a module-shaped record. It is not
 * `typeof import(...)`: several of these are partial mocks that list only
 * the exports their suites import, which is the established shape in this
 * repo and would not satisfy the full module type.
 */
type MockModule = Record<string, unknown>;

/** `vi.mock` factory for `../../core/config.js`. */
export const configMock = (): MockModule => ({
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
});

/** `vi.mock` factory for `../../core/mach.js`. */
export const machMock = (): MockModule => {
  // One shared dispatch mock backs every capture dispatch: `runMachTestSuite`
  // takes the mach command kind as its first argument, so assertions here
  // stay valid no matter which suite a test's paths classify as (the default
  // classification, findNearestXpcshellManifest → null, routes to
  // `mochitest`). The dedicated E1 dispatch test asserts on the kind.
  const captureDispatch = vi.fn();
  return {
    hasBuildArtifacts: vi.fn(() => Promise.resolve({ exists: true, objDir: 'obj-debug' })),
    // Default to "launchable bundle present" so existing tests pass through
    // the runnable-bundle preflight. The regression test for the
    // missing-binary branch overrides this with
    // mockResolvedValueOnce({ runnable: false, ... }).
    hasRunnableBundle: vi.fn(() =>
      Promise.resolve({ runnable: true, expectedPath: 'obj-debug/dist/bin/firefox' })
    ),
    buildArtifactMismatchMessage: vi.fn(() => undefined),
    runProtectedMachBuild: vi.fn(),
    runMachTestSuite: captureDispatch,
    withBuildLock: vi.fn((_projectRoot: string, operation: () => Promise<unknown>) => operation()),
  };
};

/** `vi.mock` factory for `../../core/build-prepare.js`. */
export const buildPrepareMock = (): MockModule => ({
  prepareBuildEnvironment: vi.fn(() =>
    Promise.resolve({ furnaceApplied: 0, reconfigured: false, fullBuildRequired: false })
  ),
});

/** `vi.mock` factory for `../../core/build-baseline.js`. */
export const buildBaselineMock = (): MockModule => ({
  readBuildBaseline: vi.fn(() => Promise.resolve(undefined)),
  writeBuildBaseline: vi.fn(() => Promise.resolve()),
});

/** `vi.mock` factory for `../../core/coverage-extend.js`. */
export const coverageExtendMock = async (importOriginal: ImportOriginal): Promise<MockModule> => {
  const actual = await importOriginal<typeof import('../../core/coverage-extend.js')>();
  return {
    ...actual,
    checkExtendCoverageAnchor: vi.fn(() => Promise.resolve({ ok: true })),
    checkExtendMozconfigAnchor: vi.fn(() => Promise.resolve({ ok: true })),
  };
};

/** `vi.mock` factory for `../../core/test-path-scope.js`. */
export const testPathScopeMock = async (importOriginal: ImportOriginal): Promise<MockModule> => {
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
};

/** `vi.mock` factory for `../../utils/fs.js`. */
export const fsMock = (): MockModule => ({
  pathExists: vi.fn(),
  isSymlink: vi.fn(() => Promise.resolve(false)),
  removeFile: vi.fn(() => Promise.resolve()),
});

/** `vi.mock` factory for `../../utils/logger.js`. */
export const loggerMock = (): MockModule => ({
  // Verbose + stdout-seal state: the CLI error boundary consults both
  // before walking a cause chain or emitting a --json error envelope.
  isVerbose: vi.fn(() => false),
  isStdoutSealed: vi.fn(() => false),

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
});

/** `vi.mock` factory for `../../utils/platform.js`. */
export const platformMock = async (importOriginal: ImportOriginal): Promise<MockModule> => ({
  ...(await importOriginal<typeof import('../../utils/platform.js')>()),
  // Pin the platform so the headed no-output-timeout hint (darwin-only) is
  // deterministic regardless of the CI host.
  getPlatform: vi.fn(() => 'darwin'),
});

/** `vi.mock` factory for `../../core/marionette-preflight.js`. */
export const marionettePreflightMock = (): MockModule => ({
  runMarionettePreflight: vi.fn(),
  reportMarionettePreflight: vi.fn(),
  formatMarionettePreflightLine: (result: { ok: boolean; durationMs: number; detail: string }) => {
    const status = result.ok ? 'PASS' : 'FAIL';
    return `Marionette preflight: ${status} (${result.durationMs}ms) — ${result.detail}`;
  },
});

/** `vi.mock` factory for `../../core/marionette-port.js`. */
export const marionettePortMock = async (): Promise<MockModule> => {
  // Use the real `extractForwardedMarionettePort` and
  // `shouldAutoForwardMarionettePortToMach` helpers: they are pure parsing
  // utilities, and exercising them through the test command keeps the
  // integration honest. Mock only the I/O-shaped probe so the mach
  // invocation is reached.
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
};

/** `vi.mock` factory for `../../core/test-stale-check.js`. */
export const testStaleCheckMock = async (importOriginal: ImportOriginal): Promise<MockModule> => {
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
};

/** `vi.mock` factory for `../../core/xpcshell-appdir.js`. */
export const xpcshellAppdirMock = (): MockModule => ({
  findNearestXpcshellManifest: vi.fn(() => Promise.resolve(null)),
  resolveXpcshellAppdirArg: vi.fn(() => Promise.resolve({ kind: 'none' })),
  operatorAlreadySetAppPath: vi.fn(() => false),
});

/** `vi.mock` factory for `../../core/tree-store.js`. */
export const treeStoreMock = (): MockModule => ({
  assertObjdirMatchesTreeMarker: vi.fn(() => Promise.resolve()),
});
