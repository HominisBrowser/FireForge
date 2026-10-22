// SPDX-License-Identifier: EUPL-1.2
/**
 * The dispatch half of `fireforge test`: which shape a request runs in
 * (combined, per-argument shards, `--shard-size` chunks, `--jobs`
 * instances), the `--jobs` usage refusals, and the run-scoped drift guard.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../test-run.js', () => ({ runTestsWithRetries: vi.fn() }));
vi.mock('../../core/harness-port-fallback.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/harness-port-fallback.js')>()),
  detectHarnessPortFallback: vi.fn(() =>
    Promise.resolve({ serverPorts: false, marionettePort: false })
  ),
}));
vi.mock('../../core/harness-port-reservation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../core/harness-port-reservation.js')>()),
  reserveHarnessServerPorts: vi.fn(),
}));
vi.mock('../../core/engine-session-lock.js', () => ({
  snapshotEngineGeneration: vi.fn(() => Promise.resolve('before')),
  assertEngineGenerationUnchanged: vi.fn(() => Promise.resolve()),
}));

import { assertEngineGenerationUnchanged } from '../../core/engine-session-lock.js';
import { detectHarnessPortFallback } from '../../core/harness-port-fallback.js';
import { reserveHarnessServerPorts } from '../../core/harness-port-reservation.js';
import { InvalidArgumentError } from '../../errors/base.js';
import type { TestOptions } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { notice } from '../../utils/logger.js';
import {
  assertParallelTestUsage,
  dispatchTests,
  type TestDispatchInputs,
} from '../test-dispatch.js';
import { runTestsWithRetries, type TestRunContext, type TestRunOutcome } from '../test-run.js';
import { resetVerdictEmission } from '../test-verdict.js';

const CONFIG = { binaryName: 'mybrowser' } as FireForgeConfig;
const CTX: TestRunContext = {
  engineDir: '/engine',
  objDir: 'obj',
  classification: { xpcshell: [], nonXpcshell: [] },
  suite: 'mochitest',
  baseExtraArgs: ['--headless'],
  harnessRetries: 0,
  headless: true,
};

const GREEN: TestRunOutcome = {
  result: { exitCode: 0, stdout: '', stderr: '' },
  verdict: { kind: 'tests-ran-ok' },
  attempts: 1,
  appdirInjectionAttempted: false,
};

function inputs(options: TestOptions, paths: string[][], xpcshellOnly = false): TestDispatchInputs {
  return {
    engineDir: '/engine',
    runCtx: CTX,
    dispatchGroups: paths.map((group) => ({ label: group.join(' '), paths: group })),
    options,
    projectConfig: CONFIG,
    canaryPath: undefined,
    shuffleSeed: undefined,
    normalizedPaths: paths.flat(),
    xpcshellOnly,
    postRebuildContext: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVerdictEmission();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.mocked(runTestsWithRetries).mockResolvedValue(GREEN);
});

describe('assertParallelTestUsage', () => {
  it('passes a plain run, and a --jobs or --shard-size run with paths', () => {
    expect(() => {
      assertParallelTestUsage([], {});
      assertParallelTestUsage(['a.js'], { jobs: 2, shardSize: 3 });
      assertParallelTestUsage(['a.js'], { jobs: 1, marionettePort: 2900 });
    }).not.toThrow();
  });

  it.each<[string, string[], TestOptions]>([
    ['no paths', [], { jobs: 2 }],
    ['--canary', ['a.js'], { shardSize: 2, canary: true }],
    ['--auto', ['a.js'], { jobs: 2, auto: true }],
    ['--build-only', ['a.js'], { shardSize: 2, buildOnly: true }],
    ['a pinned Marionette port', ['a.js'], { jobs: 2, marionettePort: 2900 }],
    [
      'a forwarded Marionette port',
      ['a.js'],
      { jobs: 2, machArg: ['--setpref=marionette.port=2900'] },
    ],
  ])('refuses %s', (_label, paths, options) => {
    expect(() => {
      assertParallelTestUsage(paths, options);
    }).toThrow(InvalidArgumentError);
  });
});

describe('dispatchTests', () => {
  it('runs one combined invocation for a single argument, under the run-scoped drift guard', async () => {
    await dispatchTests(inputs({}, [['d/browser_a.js', 'd/browser_b.js']]));
    expect(runTestsWithRetries).toHaveBeenCalledWith(CTX, ['d/browser_a.js', 'd/browser_b.js']);
    expect(assertEngineGenerationUnchanged).toHaveBeenCalledWith(
      '/engine',
      'before',
      expect.any(Function)
    );
  });

  it('refuses --jobs on a browser run without auto ports, and allows it for xpcshell', async () => {
    await expect(dispatchTests(inputs({ jobs: 2 }, [['a.js'], ['b.js']]))).rejects.toThrow(
      /needs auto ports/
    );
    await dispatchTests(inputs({ jobs: 2 }, [['test_a.js'], ['test_b.js']], true));
    expect(runTestsWithRetries).toHaveBeenCalledTimes(2);
  });

  it('gives every further --jobs instance its own Marionette port and output prefix', async () => {
    await dispatchTests(inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js'], ['c.js']]));
    const contexts = vi.mocked(runTestsWithRetries).mock.calls.map(([ctx]) => ctx);
    const prefixes = new Set(contexts.map((ctx) => ctx.outputPrefix));
    expect(prefixes).toEqual(new Set(['[job 1] ', '[job 2] ']));
    const second = contexts.find((ctx) => ctx.outputPrefix === '[job 2] ');
    expect(second?.baseExtraArgs).toEqual([
      '--headless',
      `--testrun-manifest-file=fireforge-tests-${process.pid}-job2.json`,
      expect.stringMatching(/^--setpref=marionette\.port=\d+$/) as string,
      expect.stringMatching(/^--marionette=127\.0\.0\.1:\d+$/) as string,
    ]);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('on 2 harness instances at once'));
  });

  it('gives every --jobs instance its own mochitest test-list manifest (not for xpcshell)', async () => {
    // The harness writes the dispatched list to one shared tests.json; two
    // instances on the default name ran each other's files.
    await dispatchTests(inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js']]));
    const manifests = vi
      .mocked(runTestsWithRetries)
      .mock.calls.map(([ctx]) =>
        ctx.baseExtraArgs.find((arg) => arg.startsWith('--testrun-manifest-file='))
      );
    expect(new Set(manifests).size).toBe(2);
    expect(manifests).not.toContain(undefined);

    vi.mocked(runTestsWithRetries).mockClear();
    await dispatchTests(inputs({ jobs: 2 }, [['test_a.js'], ['test_b.js']], true));
    for (const [ctx] of vi.mocked(runTestsWithRetries).mock.calls) {
      expect(ctx.baseExtraArgs).toEqual(['--headless']);
    }
  });

  it('splits one directory argument into contiguous --jobs chunks', async () => {
    await dispatchTests(
      inputs({ jobs: 2, autoPorts: true, shard: false }, [['a.js', 'b.js', 'c.js', 'd.js']])
    );
    expect(vi.mocked(runTestsWithRetries).mock.calls.map(([, paths]) => paths)).toEqual(
      expect.arrayContaining([
        ['a.js', 'b.js'],
        ['c.js', 'd.js'],
      ])
    );
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('contiguous chunk(s)'));
  });

  it('chunks --shard-size requests and judges them per file', async () => {
    await expect(
      dispatchTests(inputs({ shardSize: 2 }, [['a.js', 'b.js', 'c.js']]))
    ).resolves.toBeUndefined();
    expect(vi.mocked(runTestsWithRetries).mock.calls.map(([, paths]) => paths)).toEqual([
      ['a.js', 'b.js'],
      ['c.js'],
    ]);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('chunk(s) of up to 2 file(s)'));
  });

  it('makes a sharded run inconclusive when the drift guard throws', async () => {
    vi.mocked(assertEngineGenerationUnchanged).mockRejectedValueOnce(new Error('drift'));
    await expect(dispatchTests(inputs({}, [['a.js'], ['b.js']]))).rejects.toThrow('drift');
  });

  it('gives every --jobs instance its own MOZ_UPLOAD_DIR and names them on the verdict', async () => {
    const upload = await mkdtemp(join(tmpdir(), 'ff-upload-'));
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      const base = { ...CTX, env: { MOZ_UPLOAD_DIR: upload } };
      await dispatchTests({
        ...inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js'], ['c.js']]),
        runCtx: base,
      });
      const dirs = new Set(
        vi.mocked(runTestsWithRetries).mock.calls.map(([ctx]) => ctx.env?.['MOZ_UPLOAD_DIR'])
      );
      const expected = [join(upload, 'job-1'), join(upload, 'job-2')];
      expect(dirs).toEqual(new Set(expected));
      for (const dir of expected) expect((await stat(dir)).isDirectory()).toBe(true);
      expect(writes.join('')).toContain(`upload-dirs=${expected.join(',')}`);
    } finally {
      await rm(upload, { recursive: true, force: true });
    }
  });

  it('leaves MOZ_UPLOAD_DIR unset when the caller set none', async () => {
    const saved = process.env['MOZ_UPLOAD_DIR'];
    delete process.env['MOZ_UPLOAD_DIR'];
    try {
      await dispatchTests(inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js']]));
      for (const [ctx] of vi.mocked(runTestsWithRetries).mock.calls) {
        expect(ctx.env?.['MOZ_UPLOAD_DIR']).toBeUndefined();
      }
    } finally {
      if (saved !== undefined) process.env['MOZ_UPLOAD_DIR'] = saved;
    }
  });

  it('holds the mochitest server ports for a multi-instance browser run, and releases them', async () => {
    const release = vi.fn(() => Promise.resolve());
    vi.mocked(reserveHarnessServerPorts).mockResolvedValue({ held: [8888], release });
    vi.mocked(detectHarnessPortFallback).mockResolvedValue({
      serverPorts: true,
      marionettePort: true,
    });
    const releasedDuringRun: boolean[] = [];
    vi.mocked(runTestsWithRetries).mockImplementation(() => {
      releasedDuringRun.push(release.mock.calls.length > 0);
      return Promise.resolve(GREEN);
    });
    await dispatchTests(inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js']]));
    expect(reserveHarnessServerPorts).toHaveBeenCalledTimes(1);
    expect(releasedDuringRun).toEqual([false, false]);
    expect(release).toHaveBeenCalledTimes(1);

    // One instance (a single shard), xpcshell, or an engine without the
    // fallback: nothing is held.
    vi.mocked(reserveHarnessServerPorts).mockClear();
    await dispatchTests(inputs({ jobs: 2, autoPorts: true, shard: false }, [['a.js']]));
    await dispatchTests(inputs({ jobs: 2 }, [['test_a.js'], ['test_b.js']], true));
    vi.mocked(detectHarnessPortFallback).mockResolvedValue({
      serverPorts: false,
      marionettePort: false,
    });
    await dispatchTests(inputs({ jobs: 2, autoPorts: true }, [['a.js'], ['b.js']]));
    expect(reserveHarnessServerPorts).not.toHaveBeenCalled();
  });
});
