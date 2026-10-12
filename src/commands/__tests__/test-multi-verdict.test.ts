// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  deriveControlOutcome,
  describeControlOutcome,
  formatAggregateBody,
  formatRunLine,
  parseCapturedVerdict,
  type SubRunResult,
  worstRun,
} from '../test-multi-verdict.js';

function result(repetition: number, line: string): SubRunResult {
  return { repetition, ...parseCapturedVerdict(`FIREFORGE-VERDICT: ${line}`) };
}

describe('parseCapturedVerdict', () => {
  it('reads status, reason and note', () => {
    expect(
      parseCapturedVerdict('FIREFORGE-VERDICT: FAIL reason=preflight note=stale-build')
    ).toEqual({
      body: 'FAIL reason=preflight note=stale-build',
      passed: false,
      reason: 'preflight',
      note: 'stale-build',
    });
    expect(parseCapturedVerdict('FIREFORGE-VERDICT: PASS checks=3')).toEqual({
      body: 'PASS checks=3',
      passed: true,
    });
  });

  it('treats a sub-run that wrote no verdict as a preflight failure', () => {
    expect(parseCapturedVerdict(undefined)).toMatchObject({ passed: false, reason: 'preflight' });
  });
});

describe('formatRunLine', () => {
  it('appends run= and harness= to the captured body', () => {
    expect(formatRunLine({ ...result(1, 'PASS'), harness: 'xpcshell' }, 0, 2)).toBe(
      'FIREFORGE-RUN: PASS run=1/2 harness=xpcshell'
    );
  });
});

describe('worstRun', () => {
  it('ranks the most structural failure first and ignores passes', () => {
    const results = [
      result(1, 'FAIL reason=test-failures'),
      result(2, 'FAIL reason=crash'),
      result(3, 'PASS'),
      result(4, 'FAIL reason=no-tests'),
    ];
    expect(worstRun(results)?.reason).toBe('crash');
    expect(worstRun([result(1, 'PASS')])).toBeUndefined();
    expect(
      worstRun([result(1, 'FAIL reason=novel'), result(2, 'FAIL reason=no-tests')])?.reason
    ).toBe('no-tests');
  });
});

describe('deriveControlOutcome', () => {
  it('is caught when every repetition has a test-failures run', () => {
    const results = [
      { ...result(1, 'PASS'), harness: 'xpcshell' as const },
      { ...result(1, 'FAIL reason=test-failures'), harness: 'mochitest' as const },
      { ...result(2, 'FAIL reason=test-failures'), harness: 'xpcshell' as const },
      { ...result(2, 'PASS'), harness: 'mochitest' as const },
    ];
    expect(deriveControlOutcome(results, 2, true)).toBe('caught');
  });

  it('is missed when one repetition stayed green', () => {
    expect(
      deriveControlOutcome([result(1, 'FAIL reason=test-failures'), result(2, 'PASS')], 2, true)
    ).toBe('missed');
  });

  it('is inconclusive on any other failure or an incomplete invocation', () => {
    expect(deriveControlOutcome([result(1, 'FAIL reason=crash')], 1, true)).toBe('inconclusive');
    expect(deriveControlOutcome([result(1, 'FAIL reason=test-failures')], 2, false)).toBe(
      'inconclusive'
    );
  });
});

describe('formatAggregateBody', () => {
  it('keeps a lone run whole and appends the control key', () => {
    expect(
      formatAggregateBody([result(1, 'FAIL reason=test-failures unexpected=2')], 1, 'caught')
    ).toBe('FAIL reason=test-failures unexpected=2 control=caught');
  });

  it('aggregates passes, failures with notes, and a stop before the last run', () => {
    expect(formatAggregateBody([result(1, 'PASS'), result(2, 'PASS')], 2)).toBe('PASS runs=2/2');
    expect(
      formatAggregateBody([result(1, 'PASS'), result(2, 'FAIL reason=preflight note=x')], 3)
    ).toBe('FAIL reason=preflight note=x runs=1/3');
    expect(formatAggregateBody([result(1, 'PASS')], 2)).toBe('FAIL reason=preflight runs=1/2');
  });
});

describe('describeControlOutcome', () => {
  it.each(['caught', 'missed', 'inconclusive'] as const)('names %s', (outcome) => {
    expect(describeControlOutcome(outcome)).toContain(`control=${outcome}`);
  });
});
