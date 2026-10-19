// SPDX-License-Identifier: EUPL-1.2
/**
 * The dispatch half of `fireforge test`: which shape a request runs in
 * (combined, per-argument shards, `--shard-size` chunks, `--jobs`
 * instances), the `--jobs` usage refusals, and the run-scoped drift guard.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../test-run.js', () => ({ runTestsWithRetries: vi.fn() }));
vi.mock('../../core/engine-session-lock.js', () => ({
  snapshotEngineGeneration: vi.fn(() => Promise.resolve('before')),
  assertEngineGenerationUnchanged: vi.fn(() => Promise.resolve()),
}));

import { assertEngineGenerationUnchanged } from '../../core/engine-session-lock.js';
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
      expect.stringMatching(/^--setpref=marionette\.port=\d+$/) as string,
      expect.stringMatching(/^--marionette=127\.0\.0\.1:\d+$/) as string,
    ]);
    expect(notice).toHaveBeenCalledWith(expect.stringContaining('on 2 harness instances at once'));
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
});
