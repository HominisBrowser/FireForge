// SPDX-License-Identifier: EUPL-1.2
/**
 * What a `fireforge test` pays in whole-engine git walks, and what those walks
 * still catch, through the real command over a real git checkout and the real
 * engine-session lock where the case is about it. Only the harness, the browser and port probes are
 * stubbed; `git` is wrapped to count, and every call runs for real.
 *
 * A walk is anything that visits every tracked file or the whole untracked set.
 * On a patched Firefox checkout one costs seconds, so this suite pins the budget.
 */
import { execFileSync } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ args: [] as string[][] }));

vi.mock('../../core/git-base.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/git-base.js')>();
  return {
    ...actual,
    git: (args: string[], cwd: string, options?: never) => {
      calls.args.push(args);
      return actual.git(args, cwd, options);
    },
  };
});
vi.mock('../../utils/logger.js', async () =>
  (await import('./test-command-mocks.js')).loggerMock()
);
vi.mock('../../core/run-log.js', async () =>
  (await import('../../test-utils/module-mocks.js')).createRunLogMock()
);
vi.mock('../../core/test-host-state.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testHostStateMock(importOriginal)
);
vi.mock('../../core/mach.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/mach.js')>()),
  ...(await import('./test-command-mocks.js')).machMock(),
  generateMozconfig: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('../../core/marionette-port.js', async () =>
  (await import('./test-command-mocks.js')).marionettePortMock()
);
vi.mock('../../core/marionette-preflight.js', async () =>
  (await import('./test-command-mocks.js')).marionettePreflightMock()
);
vi.mock('../../core/mochitest-server-port.js', () => ({
  ensureMochitestServerPortAvailable: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../core/xpcshell-appdir.js', async () =>
  (await import('./test-command-mocks.js')).xpcshellAppdirMock()
);
vi.mock('../../core/tree-store.js', async () =>
  (await import('./test-command-mocks.js')).treeStoreMock()
);
vi.mock('../../core/test-path-scope.js', async (importOriginal) =>
  (await import('./test-command-mocks.js')).testPathScopeMock(importOriginal)
);
vi.mock('../../core/branding.js', () => ({
  isBrandingSetup: vi.fn(() => Promise.resolve(true)),
  setupBranding: vi.fn(() => Promise.resolve()),
}));
vi.mock('../test-browser-preflight.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-browser-preflight.js')>()),
  ensureTestBrowserEnvironment: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../test-harness-teardown.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../test-harness-teardown.js')>()),
  createHarnessTeardown: vi.fn(() => ({
    prepare: () => Promise.resolve(),
    dispose: () => undefined,
    afterClose: () => Promise.resolve(),
  })),
}));

import * as buildBaseline from '../../core/build-baseline.js';
import { writeBuildBaseline } from '../../core/build-baseline.js';
import {
  readEngineSessionLockStatus,
  withEngineSessionLock,
} from '../../core/engine-session-lock.js';
import { runMachTestSuite, runProtectedMachBuild } from '../../core/mach.js';
import { assertMarionettePortAvailable } from '../../core/marionette-port.js';
import { InconclusiveVerdictError, PreflightRefusalError } from '../../errors/base.js';
import {
  createTempProject,
  removeTempProject,
  writeFiles,
  writeFireForgeConfig,
} from '../../test-utils/index.js';
import { testCommand } from '../test.js';
import { ensureTestBrowserEnvironment } from '../test-browser-preflight.js';
import { resetVerdictEmission } from '../test-verdict.js';

const TEST = 'browser/base/content/test/browser_a.js';
const PATCHED = 'browser/base/content/patched.js';
const ADDED = 'browser/base/content/added.js';
const OBJ = 'obj-debug';
const SEP = '\x1f';
const GREEN = {
  exitCode: 0,
  stdout: `TEST-START | ${TEST}\nTEST-OK | ${TEST}\nPassed: 3\nRan 1 checks\nUnexpected results: 0\nSUITE_END\n`,
  stderr: '',
};

let root: string;
let engine: string;
let writes: string[];

const isWalk = (args: readonly string[]): boolean =>
  args.includes('status') ||
  args.includes('ls-files') ||
  (args.includes('diff') && args.includes('HEAD'));
const walks = (): number => calls.args.filter(isWalk).length;

function git(...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: engine });
}

const ensureMarionetteCalls = (): number =>
  vi.mocked(assertMarionettePortAvailable).mock.calls.length;

const verdicts = (): string[] =>
  writes.filter((line) => line.startsWith('FIREFORGE-VERDICT:')).map((line) => line.trimEnd());

/** Records how many walks each dispatch found already paid, running `during` per dispatch. */
function dispatches(during: (index: number) => Promise<void> = () => Promise.resolve()): number[] {
  const seen: number[] = [];
  vi.mocked(runMachTestSuite).mockImplementation(async () => {
    seen.push(walks());
    await during(seen.length - 1);
    return GREEN;
  });
  return seen;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetVerdictEmission();
  vi.stubEnv('FIREFORGE_ENABLE_ENGINE_SESSION_LOCK_IN_TEST', '1');
  root = await createTempProject('ff-engine-walks-');
  engine = join(root, 'engine');
  await writeFireForgeConfig(root);
  await writeFiles(engine, {
    [TEST]: 'test\n',
    [PATCHED]: 'stock\n',
    'browser/base/content/copied.js': 'stock\n',
  });
  git('init', '-q');
  git('add', '.');
  git('commit', '-qm', 'base');
  // The permanently dirty tree of a patched fork, already built into the record.
  await writeFiles(engine, { [PATCHED]: 'patched\n', [ADDED]: 'added\n' });
  await writeBuildBaseline({
    projectRoot: root,
    engineDir: engine,
    binaryName: 'mybrowser',
    testPackagingCoverage: 'full',
  });
  calls.args = [];
  writes = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await removeTempProject(root);
});

describe('walks of the engine', () => {
  it('a build-less single run pays one before the harness and one after', async () => {
    const seen = dispatches();
    await testCommand(root, [TEST], {});
    expect(seen).toEqual([1]);
    expect(walks()).toBe(2);
    expect(verdicts()[0]).toMatch(/^FIREFORGE-VERDICT: PASS/);
  });

  it('each later --repeat run reuses the last "after", paying only its own', async () => {
    const seen = dispatches();
    await testCommand(root, [TEST], { repeat: 3 });
    expect(seen).toEqual([1, 2, 3]);
    expect(walks()).toBe(4);
    expect(verdicts()[0]).toMatch(/^FIREFORGE-VERDICT: PASS runs=3\/3/);
  });

  it('adds the pre-lock pass only when a peer makes the run wait', async () => {
    const seen = dispatches();
    let entered = (): void => undefined;
    let release = (): void => undefined;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const peer = withEngineSessionLock(root, 'peer', async () => {
      entered();
      await released;
    });
    await holding;
    const run = testCommand(root, [TEST], {}, (body) =>
      withEngineSessionLock(root, 'test', body, { waitLockSeconds: 30 })
    );
    await vi.waitFor(async () => {
      expect((await readEngineSessionLockStatus(root)).queueDepth).toBe(1);
    });
    expect(walks()).toBe(1);
    release();
    await Promise.all([peer, run]);
    expect(seen).toEqual([2]);
  });

  it('a --build run measures once before the build, once after it, once after the harness', async () => {
    const seen = dispatches();
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    await testCommand(root, [TEST], { build: true, furnaceApply: 'none' });
    expect(seen).toEqual([2]);
    expect(walks()).toBe(3);
  });
});

describe('a flag with no build to shape', () => {
  it.each([
    ['--furnace-apply', { furnaceApply: 'all' }],
    ['--no-furnace-apply', { furnaceApply: false }],
    ['--refuse-unexported-drift', { refuseUnexportedDrift: true }],
    ['--extend-coverage', { extendCoverage: true }],
  ] as const)('%s refuses before the lock, any wait or any walk', async (flag, options) => {
    const underLock = vi.fn((body: () => Promise<void>) => body());
    await expect(testCommand(root, [TEST], options, underLock)).rejects.toMatchObject({
      message: expect.stringContaining(`${flag} requires --build`) as string,
    });
    expect(underLock).not.toHaveBeenCalled();
    expect(ensureMarionetteCalls()).toBe(0);
    expect(walks()).toBe(0);
  });
});

describe('what a kept measurement still catches', () => {
  it('a peer edit during the run is in the guard, though the gate walked long before', async () => {
    const seen = dispatches(() => writeFile(join(engine, TEST), 'peer edit\n'));
    await expect(testCommand(root, [TEST], {})).rejects.toBeInstanceOf(InconclusiveVerdictError);
    expect(seen).toEqual([1]);
    expect(verdicts()).toEqual([expect.stringContaining('FAIL reason=inconclusive')]);
  });

  it('a second edit to an already dirty file is seen, which git status alone cannot', async () => {
    dispatches(() => writeFile(join(engine, PATCHED), 'patched again\n'));
    await expect(testCommand(root, [TEST], {})).rejects.toBeInstanceOf(InconclusiveVerdictError);
  });

  it('an edit between two sub-runs is in the next guard, though no gate looks again', async () => {
    const seen = dispatches();
    vi.mocked(ensureTestBrowserEnvironment)
      .mockImplementationOnce(() => Promise.resolve({}) as never)
      .mockImplementationOnce(async () => {
        await writeFile(join(engine, TEST), 'edit between the runs\n');
        return {} as never;
      });
    await expect(testCommand(root, [TEST], { repeat: 3 })).rejects.toBeInstanceOf(
      InconclusiveVerdictError
    );
    expect(seen).toEqual([1, 2]);
    expect(verdicts()[0]).toMatch(/reason=inconclusive/);
  });

  it('a stale tree is still refused, on the single in-lock pass', async () => {
    const seen = dispatches();
    await writeFile(join(engine, PATCHED), 'edited since the build\n');
    await expect(testCommand(root, [TEST], {})).rejects.toMatchObject({ note: 'stale-build' });
    expect(seen).toEqual([]);
    expect(walks()).toBe(1);
  });
});

describe('a pre-test build whose record cannot be written', () => {
  it('stops the run, since nothing could judge this packaging afterwards', async () => {
    const seen = dispatches();
    vi.mocked(runProtectedMachBuild).mockResolvedValue({
      exitCode: 0,
      stdout: '',
      stderr: '',
      attempts: 1,
    });
    vi.spyOn(buildBaseline, 'writeBuildBaseline').mockRejectedValue(new Error('ENOSPC'));
    await expect(testCommand(root, [TEST], { build: true })).rejects.toMatchObject({
      note: 'baseline-write-failed',
      message: expect.stringContaining('ENOSPC') as string,
    });
    expect(seen).toEqual([]);
    expect(verdicts()[0]).toContain('note=baseline-write-failed');
  });
});

describe('a peer in a stress sequence', () => {
  const COPIED = 'browser/base/content/copied.js';

  it('does not void a run over an edit the browser cannot see, nor re-judge the tree', async () => {
    // An objdir that copied the file, so an edit to it cannot reach the runtime.
    await writeFile(join(engine, '.git/info/exclude'), `${OBJ}/\n`);
    await writeFiles(engine, {
      [`${OBJ}/_build_manifests/install/dist_bin`]: `5\n2${SEP}chrome/copied.js${SEP}${join(engine, COPIED)}\n`,
    });
    const seen = dispatches((index) =>
      index === 1 ? writeFile(join(engine, COPIED), 'peer edit\n') : Promise.resolve()
    );
    await testCommand(root, [TEST], { repeat: 3 });
    expect(seen).toEqual([1, 2, 3]);
    expect(verdicts()[0]).toMatch(/^FIREFORGE-VERDICT: PASS runs=3\/3/);
    expect(verdicts()[0]).toContain('drift-tolerated=1');
  });
});

describe('no recorded build', () => {
  beforeEach(async () => {
    await rm(join(root, '.fireforge/last-build.json'));
  });

  it('refuses: a missing record is not a fresh one', async () => {
    const seen = dispatches();
    await expect(testCommand(root, [TEST], {})).rejects.toBeInstanceOf(PreflightRefusalError);
    expect(seen).toEqual([]);
    expect(verdicts()[0]).toContain('note=no-build-baseline');
  });

  it('--allow-stale-build runs, and the verdict says nothing vouched for it', async () => {
    dispatches();
    await testCommand(root, [TEST], { allowStaleBuild: true });
    expect(verdicts()[0]).toMatch(/^FIREFORGE-VERDICT: PASS/);
    expect(verdicts()[0]).toContain('baseline=none');
  });
});
