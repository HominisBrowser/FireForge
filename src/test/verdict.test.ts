// SPDX-License-Identifier: EUPL-1.2
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ExitCode, FireForgeError } from '../kernel/errors.js';
import { useTempDir } from '../testing/temp.js';
import type { HarnessVerdict } from './classify.js';
import type { ControlResult } from './control.js';
import type { TestPlan } from './plan.js';
import type { DispatchResult, TestRunResult } from './run.js';
import { controlReport, refusalLines, refusalVerdict, runReport, writeResults } from './verdict.js';

const dir = useTempDir();
const A = 'browser/base/content/test/fork/browser_a.js';
const B = 'browser/base/content/test/fork/browser_b.js';

function dispatch(
  paths: string[],
  verdict: HarnessVerdict,
  overrides: Partial<DispatchResult> = {}
): DispatchResult {
  return {
    run: 1,
    index: 1,
    suite: 'mochitest',
    paths,
    exitCode: verdict.kind === 'pass' ? 0 : 1,
    attempts: 1,
    verdict,
    silentSegfault: false,
    files: paths.map((test) => ({
      test,
      run: 1,
      dispatch: 1,
      planned: true,
      started: true,
      finished: true,
      unexpected: verdict.kind !== 'pass',
      failures: [],
    })),
    ...overrides,
  };
}

function result(
  dispatches: DispatchResult[],
  overrides: Partial<TestRunResult> = {}
): TestRunResult {
  const plan: TestPlan = {
    paths: dispatches.flatMap((entry) => entry.paths),
    tests: dispatches.flatMap((entry) => entry.paths.map((path) => ({ path, suite: entry.suite }))),
    dispatches: dispatches.map((entry) => ({
      suite: entry.suite,
      paths: entry.paths,
      restart: false,
    })),
    repeat: 1,
    headed: false,
  };
  const pass = dispatches.every((entry) => entry.verdict.kind === 'pass');
  return {
    pass,
    ...(pass ? {} : { reason: 'test-failures' as const }),
    plan,
    dispatches,
    log: '/runs/output.log',
    tree: 'abc',
    reaped: 0,
    ...overrides,
  };
}

describe('runReport', () => {
  it('passes one dispatch with its counts, its noise note and the log', () => {
    const report = runReport(
      result([
        dispatch([A], { kind: 'pass', checks: 3, unexpected: 0, note: 'teardown-noise-ignored' }),
      ]),
      { results: '/runs/results.json' }
    );
    expect(report.pass).toBe(true);
    expect(report.failure).toBeUndefined();
    expect(report.fields).toMatchObject({
      checks: 3,
      unexpected: 0,
      note: 'teardown-noise-ignored',
      log: '/runs/output.log',
      results: '/runs/results.json',
    });
    expect(report.lines).toEqual([`PASS checks=3 unexpected=0  ${A}`]);
    expect(report.document).toMatchObject({
      verdict: 'pass',
      summary: { files: 1, passed: 1, failed: 0, unfinished: 0, neverStarted: 0 },
    });
  });

  it('counts shards and repetitions, and names the deciding dispatch of a red', () => {
    const red: HarnessVerdict = {
      kind: 'test-failures',
      failureLine: 'TEST-UNEXPECTED-FAIL | b | boom',
      incomplete: { started: 1, requested: 2, firstUnstarted: B, startedSource: 'raw' },
    };
    const shards = runReport(result([dispatch([A], { kind: 'pass' }), dispatch([B], red)]));
    expect(shards.pass).toBe(false);
    expect(shards.fields).toMatchObject({
      reason: 'test-failures',
      shards: '1/2',
      started: '1/2',
      'first-unstarted': B,
      'started-source': 'raw',
    });
    expect(shards.lines).toEqual([
      `PASS  ${A}`,
      `FAIL test-failures  ${B}`,
      `The run is incomplete and was NOT treated as a pass:\n  - only 1 of 2 requested test files started; the first that never started is ${B}`,
      'TEST-UNEXPECTED-FAIL | b | boom',
    ]);
    expect(shards.failure).toBeInstanceOf(FireForgeError);
    expect(shards.failure).toMatchObject({
      code: 'test-failure',
      exitCode: ExitCode.BUILD_ERROR,
      hint: 'The lines above say what failed; the complete output is /runs/output.log.',
    });

    const repeated = result([
      dispatch([A], { kind: 'pass' }),
      dispatch([A], { kind: 'test-failures' }, { run: 2 }),
    ]);
    repeated.plan.repeat = 2;
    repeated.plan.dispatches = repeated.plan.dispatches.slice(0, 1);
    const report = runReport(repeated);
    expect(report.fields).toMatchObject({ runs: '1/2' });
    expect(report.fields['shards']).toBeUndefined();
    expect(report.lines[0]).toBe(`PASS  run 1, ${A}`);
  });

  it('explains a crash, a server that never started, no tests and a silent SIGSEGV', () => {
    const lines = (verdict: HarnessVerdict, overrides: Partial<DispatchResult> = {}): string =>
      runReport(result([dispatch([A, B], verdict, overrides)])).lines.join('\n');
    expect(
      lines(
        {
          kind: 'crash',
          signature: {
            reason: 'no-output timeout before any test started',
            line: 'timed out after 370 seconds with no output',
            harnessLines: ['httpd on port 8888'],
          },
        },
        { attempts: 2 }
      )
    ).toContain(
      'on all 2 attempt(s).\nRecognized: no-output timeout before any test started\nEvidence: timed out after 370 seconds with no output\nHarness lines before the timeout:\n  httpd on port 8888'
    );
    expect(
      lines({
        kind: 'crash',
        signature: { reason: 'server', line: 'port 8888 in use', verdictReason: 'server-startup' },
      })
    ).toMatch(/^FAIL server-startup {2}2 mochitest files\nA mochitest server could not start/);
    expect(lines({ kind: 'no-tests', checks: 0 }, { exitCode: 0 })).toContain(
      'The harness exited 0, but a summary without a single test start is not a result. The summary counted zero checks'
    );
    expect(lines({ kind: 'crash' }, { exitCode: 139, silentSegfault: true })).toContain(
      'The harness died on SIGSEGV (exit 139) having printed nothing at all.'
    );
  });

  it('says why a green summary was refused, and fails an engine that moved as inconclusive', () => {
    const refused = runReport(
      result([
        dispatch([A], {
          kind: 'test-failures',
          greenSummaryRejected: { crashLine: 'PROCESS-CRASH', neverStarted: [B], neverEnded: [] },
        }),
      ])
    );
    expect(refused.lines.join('\n')).toContain(
      'mach exited 1 and the embedded suite summary looks green, but it was NOT treated as a pass:\n  - crash evidence: PROCESS-CRASH\n' +
        `  - requested test file(s) that never started: ${B}`
    );
    const moved = runReport(
      result([dispatch([A], { kind: 'pass' })], {
        pass: false,
        reason: 'inconclusive',
        engineMoved: ['browser/a.js'],
      })
    );
    expect(moved.failure).toMatchObject({
      code: 'test-inconclusive',
      exitCode: ExitCode.INCONCLUSIVE,
    });
    expect(moved.lines.at(-1)).toBe(
      'The engine changed while the harness ran, so the result was discarded: browser/a.js'
    );
  });
});

describe('controlReport', () => {
  const green = result([dispatch([A], { kind: 'pass' })]);
  const red = result([dispatch([A], { kind: 'test-failures' })]);
  const control = (overrides: Partial<ControlResult>): ControlResult => ({
    outcome: 'caught',
    targets: ['browser/a.js'],
    baseline: green,
    mutated: red,
    ...overrides,
  });

  it('passes a caught control on the mutated run, with control=caught', () => {
    const report = controlReport(control({}));
    expect(report.pass).toBe(true);
    expect(report.fields).toMatchObject({ control: 'caught' });
    expect(report.fields['reason']).toBeUndefined();
    expect(report.lines).toContain('With the mutation:');
    expect(report.lines.at(-1)).toBe(
      'Negative control caught: the tests went red at exactly the expected assertions.'
    );
    expect(report.document).toMatchObject({ verdict: 'pass', control: 'caught' });
  });

  it('fails a missed, wrong-red or baseline-red control with exit 5 and keeps 14 for a moved engine', () => {
    const missed = controlReport(control({ outcome: 'missed', mutated: green }));
    expect(missed.fields).toMatchObject({ reason: 'control-missed', control: 'missed' });
    expect(missed.failure).toMatchObject({
      code: 'control-missed',
      exitCode: ExitCode.BUILD_ERROR,
    });
    const why = 'expected "the guard holds"; the run was red at "the tile keeps its size"';
    const wrongRed = controlReport(control({ outcome: 'wrong-red', why, mutated: red }));
    expect(wrongRed.pass).toBe(false);
    expect(wrongRed.fields).toMatchObject({ reason: 'control-wrong-red', control: 'wrong-red' });
    expect(wrongRed.failure).toMatchObject({
      code: 'control-wrong-red',
      exitCode: ExitCode.BUILD_ERROR,
      message: `The negative control went red, but not at exactly the expected assertions: ${why}.`,
    });
    expect(wrongRed.lines.at(-1)).toBe(
      `Negative control FAILED, red at the wrong assertions: ${why}`
    );
    expect(wrongRed.document).toMatchObject({ verdict: 'fail', control: 'wrong-red', why });
    expect(JSON.stringify([wrongRed.fields, wrongRed.lines.at(-1)])).not.toContain('inconclusive');

    const baselineRed = controlReport({
      outcome: 'baseline-red',
      why: 'the tests were red without it',
      targets: ['browser/a.js'],
      baseline: red,
    });
    expect(baselineRed.fields).toMatchObject({
      reason: 'control-baseline-red',
      control: 'baseline-red',
    });
    expect(baselineRed.failure).toMatchObject({
      code: 'control-baseline-red',
      exitCode: ExitCode.BUILD_ERROR,
    });

    const moved = controlReport(
      control({ outcome: 'inconclusive', why: 'the engine changed', mutated: red })
    );
    expect(moved.fields).toMatchObject({ reason: 'inconclusive', control: 'inconclusive' });
    expect(moved.failure).toMatchObject({
      code: 'control-inconclusive',
      exitCode: ExitCode.INCONCLUSIVE,
    });
    expect(moved.lines.at(-1)).toBe('Negative control inconclusive: the engine changed');
  });
});

describe('refusals and the results document', () => {
  it('reads a refusal as preflight with its code, a lock timeout as itself', () => {
    const refusal = new FireForgeError('not-a-test', 'x is not a test', { hint: 'Name a test.' });
    expect(refusalVerdict(refusal)).toEqual({ reason: 'preflight', note: 'not-a-test' });
    expect(refusalVerdict(new FireForgeError('lock-timeout', 'held'))).toEqual({
      reason: 'lock-timeout',
    });
    expect(refusalVerdict(new Error('boom'))).toEqual({ reason: 'preflight', note: 'internal' });
    expect(refusalLines(refusal)).toEqual([
      'Preflight refused:',
      'x is not a test',
      'Name a test.',
    ]);
    expect(refusalLines(new Error('boom'))).toEqual(['Preflight refused:', 'boom']);
  });

  it('writes the results document with its schema version', async () => {
    const path = join(dir(), 'results.json');
    await writeResults(path, runReport(result([dispatch([A], { kind: 'pass' })])).document);
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      verdict: 'pass',
      tree: 'abc',
    });
  });
});
