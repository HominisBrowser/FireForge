// SPDX-License-Identifier: EUPL-1.2
/**
 * The shard runner: `FIREFORGE-SHARD:` lines, `--jobs` instance pools,
 * `--shard-size` chunks judged per file, and contiguous `--jobs` chunks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HarnessRunVerdict } from '../../core/test-harness-crash.js';
import { createLoggerMock } from '../../test-utils/module-mocks.js';

vi.mock('../../utils/logger.js', () => createLoggerMock());
vi.mock('../test-run.js', () => ({ runTestsWithRetries: vi.fn() }));

import type { RawTestResult } from '../../core/test-raw-log.js';
import { warn } from '../../utils/logger.js';
import { runTestsWithRetries, type TestRunContext, type TestRunOutcome } from '../test-run.js';
import {
  chunkShardGroups,
  deriveAggregateShardVerdict,
  failedFilesOf,
  formatShardLine,
  runShardedTests,
  splitContiguous,
} from '../test-shards.js';

const CTX: TestRunContext = {
  engineDir: '/engine',
  objDir: 'obj',
  classification: { xpcshell: [], nonXpcshell: [] },
  suite: 'mochitest',
  baseExtraArgs: [],
  harnessRetries: 0,
  headless: true,
};

function outcome(kind: HarnessRunVerdict['kind'], files?: RawTestResult[]): TestRunOutcome {
  return {
    result: { exitCode: kind === 'tests-ran-ok' ? 0 : 1, stdout: '', stderr: '' },
    verdict: { kind },
    attempts: 1,
    appdirInjectionAttempted: false,
    ...(files === undefined ? {} : { fileResults: files }),
  };
}

function result(test: string, unexpected = false): RawTestResult {
  return {
    test,
    status: unexpected ? 'FAIL' : 'OK',
    expected: 'OK',
    unexpected,
    unexpectedSubtests: 0,
  };
}

let stdout: string[];

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array): boolean => {
    stdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  });
});

describe('formatShardLine', () => {
  it('prints the verdict body with shard, path and failed files', () => {
    expect(
      formatShardLine({ label: 'dir/a b.js', outcome: outcome('test-failures') }, 1, 3, ['x.js'])
    ).toBe(
      'FIREFORGE-SHARD: FAIL reason=test-failures shard=2/3 path=dir/a_b.js failed-files=x.js'
    );
    expect(formatShardLine({ label: 'a.js', outcome: outcome('tests-ran-ok') }, 0, 1)).toBe(
      'FIREFORGE-SHARD: PASS shard=1/1 path=a.js'
    );
  });
});

describe('server ports and server-startup shards', () => {
  it('names the mochitest server ports an instance took on its shard line', () => {
    const shard = {
      label: 'a.js',
      outcome: { ...outcome('tests-ran-ok'), serverPorts: { http: 53001, ssl: 53002, ws: 53003 } },
    };
    expect(formatShardLine(shard, 0, 2)).toBe(
      'FIREFORGE-SHARD: PASS shard=1/2 path=a.js ports=http:53001,ssl:53002,ws:53003'
    );
  });

  it('says reason=server-startup on the shard and aggregate lines when only servers failed', () => {
    const signature = {
      reason: 'mochitest server failed to start (server-startup)',
      line: '!!! could not start server on port 8888',
      verdictReason: 'server-startup' as const,
    };
    const startup: TestRunOutcome = {
      ...outcome('harness-crash'),
      verdict: { kind: 'harness-crash', signature },
    };
    expect(formatShardLine({ label: 'a.js', outcome: startup }, 0, 1)).toBe(
      'FIREFORGE-SHARD: FAIL reason=server-startup shard=1/1 path=a.js'
    );
    const only = deriveAggregateShardVerdict([
      { label: 'a.js', outcome: startup },
      { label: 'b.js', outcome: outcome('tests-ran-ok') },
    ]);
    expect(only.signature?.verdictReason).toBe('server-startup');
    const mixed = deriveAggregateShardVerdict([
      { label: 'a.js', outcome: startup },
      { label: 'b.js', outcome: outcome('harness-crash') },
    ]);
    expect(mixed).toEqual({ kind: 'harness-crash' });
  });
});

describe('failedFilesOf', () => {
  it('names unexpected and unfinished files, and defers without a raw log', () => {
    const shard = {
      label: 'c',
      paths: ['d/browser_a.js', 'd/browser_b.js', 'd/browser_c.js'],
      outcome: outcome('test-failures', [
        result('browser/x/d/browser_a.js'),
        result('d/browser_b.js', true),
      ]),
    };
    expect(failedFilesOf(shard)).toEqual(['d/browser_b.js', 'd/browser_c.js']);
    expect(failedFilesOf({ label: 'c', outcome: outcome('tests-ran-ok') })).toBeUndefined();
  });
});

describe('chunking', () => {
  it('cuts the flattened request every n files, in order', () => {
    expect(
      chunkShardGroups(
        [
          { label: 'd', paths: ['a', 'b', 'c'] },
          { label: 'e', paths: ['d'] },
        ],
        2
      )
    ).toEqual([
      { label: 'a+1', paths: ['a', 'b'] },
      { label: 'c+1', paths: ['c', 'd'] },
    ]);
  });

  it('splits a request into near-equal contiguous chunks, never more than files', () => {
    expect(splitContiguous(['a', 'b', 'c', 'd', 'e'], 2)).toEqual([
      { label: 'a+2', paths: ['a', 'b', 'c'] },
      { label: 'd+1', paths: ['d', 'e'] },
    ]);
    expect(splitContiguous(['a'], 4)).toEqual([{ label: 'a', paths: ['a'] }]);
  });
});

describe('runShardedTests', () => {
  it('prints one FIREFORGE-SHARD line per shard and names failed shards', async () => {
    vi.mocked(runTestsWithRetries)
      .mockResolvedValueOnce(outcome('tests-ran-ok'))
      .mockResolvedValueOnce(outcome('harness-crash'));
    const summary = await runShardedTests(
      CTX,
      [
        { label: 'a.js', paths: ['a.js'] },
        { label: 'b.js', paths: ['b.js'] },
      ],
      () => 'diagnosis'
    );
    expect(summary).toMatchObject({ passed: 1, total: 2, failed: ['b.js'] });
    expect(stdout.filter((line) => line.startsWith('FIREFORGE-SHARD:'))).toEqual([
      'FIREFORGE-SHARD: PASS shard=1/2 path=a.js\n',
      'FIREFORGE-SHARD: FAIL reason=crash shard=2/2 path=b.js\n',
    ]);
    expect(warn).toHaveBeenCalledWith('diagnosis');
  });

  it('runs shards on --jobs instances at once, each with its own context, keeping order', async () => {
    const seen: Array<string | undefined> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(runTestsWithRetries).mockImplementation(async (ctx, paths) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(ctx.outputPrefix);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (paths[0] === 'c.js') ctx.powerChanged = true;
      return outcome(paths[0] === 'b.js' ? 'test-failures' : 'tests-ran-ok');
    });
    const base = { ...CTX, outputPrefix: '[job 1] ' };
    const contextFor = vi.fn((index: number) => ({ ...CTX, outputPrefix: `[job ${index + 1}] ` }));
    const summary = await runShardedTests(
      base,
      ['a.js', 'b.js', 'c.js', 'd.js'].map((path) => ({ label: path, paths: [path] })),
      () => undefined,
      { jobs: 2, contextFor }
    );
    expect(maxInFlight).toBe(2);
    expect(new Set(seen)).toEqual(new Set(['[job 1] ', '[job 2] ']));
    expect(contextFor).toHaveBeenCalledTimes(1);
    expect(summary.shards.map((shard) => shard.label)).toEqual(['a.js', 'b.js', 'c.js', 'd.js']);
    expect(summary.failed).toEqual(['b.js']);
    expect(base.powerChanged).toBe(true);
  });

  it('judges --shard-size chunks per file from the raw log', async () => {
    vi.mocked(runTestsWithRetries)
      .mockResolvedValueOnce(
        outcome('test-failures', [result('d/browser_a.js'), result('d/browser_b.js', true)])
      )
      .mockResolvedValueOnce(outcome('harness-crash', []))
      .mockResolvedValueOnce(outcome('harness-crash'));
    const summary = await runShardedTests(
      CTX,
      [
        { label: 'd/browser_a.js+1', paths: ['d/browser_a.js', 'd/browser_b.js'] },
        { label: 'd/browser_c.js', paths: ['d/browser_c.js'] },
        { label: 'd/browser_d.js', paths: ['d/browser_d.js'] },
      ],
      () => undefined,
      { perFile: true }
    );
    expect(summary).toMatchObject({
      passed: 1,
      total: 4,
      failed: ['d/browser_b.js', 'd/browser_c.js', 'd/browser_d.js'],
    });
    expect(stdout[0]).toBe(
      'FIREFORGE-SHARD: FAIL reason=test-failures shard=1/3 path=d/browser_a.js+1 failed-files=d/browser_b.js\n'
    );
  });

  it('counts a green chunk with a raw log as passed files', async () => {
    vi.mocked(runTestsWithRetries).mockResolvedValueOnce(
      outcome('tests-ran-ok', [result('d/browser_a.js')])
    );
    const summary = await runShardedTests(
      CTX,
      [{ label: 'd/browser_a.js', paths: ['d/browser_a.js'] }],
      () => undefined,
      { perFile: true }
    );
    expect(summary).toMatchObject({ passed: 1, total: 1, failed: [] });
  });
});
