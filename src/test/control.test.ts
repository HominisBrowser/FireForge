// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { describeLabels, judgeLabels, labelRefusal, matchesLabel } from './control.js';
import type { AssertionFailure } from './rawLog.js';
import type { TestRunResult } from './run.js';

const xpcshell: AssertionFailure = {
  assertion: 'test_wire_three_streams',
  status: 'FAIL',
  expected: 'PASS',
  message: 'the stream settled - false == true',
};
const mochitest: AssertionFailure = {
  assertion: 'the guard holds',
  status: 'FAIL',
  expected: 'PASS',
};

/** A mutated run whose repetitions produced these reds. */
function run(...repetitions: AssertionFailure[][]): TestRunResult {
  return {
    plan: { repeat: repetitions.length },
    dispatches: repetitions.map((failures, index) => ({
      run: index + 1,
      files: [{ test: 'a/test_wire.js', failures }],
    })),
  } as unknown as TestRunResult;
}

describe('control labels', () => {
  it('matches an xpcshell red by its task, its whole assertion text, or that text before the details', () => {
    expect(matchesLabel(xpcshell, 'test_wire_three_streams')).toBe(true);
    expect(matchesLabel(xpcshell, 'the stream settled')).toBe(true);
    expect(matchesLabel(xpcshell, 'the stream settled - false == true')).toBe(true);
    expect(matchesLabel(xpcshell, 'the stream')).toBe(false);
    expect(matchesLabel(mochitest, 'the guard holds')).toBe(true);
    expect(matchesLabel(mochitest, 'the guard')).toBe(false);
  });

  it('needs every label met and every red named', () => {
    expect(judgeLabels(['the stream settled'], [xpcshell]).matched).toBe(true);
    expect(judgeLabels(['the stream settled'], [xpcshell, mochitest])).toMatchObject({
      matched: false,
      unrelated: [mochitest],
    });
    expect(judgeLabels(['elsewhere'], [xpcshell])).toMatchObject({
      matched: false,
      missing: ['elsewhere'],
    });
    expect(judgeLabels([], []).matched).toBe(false);
  });

  it('names every label a red carried, so a refusal can be copied into --expect', () => {
    expect(describeLabels([xpcshell, mochitest])).toBe(
      '"test_wire_three_streams" (assertion "the stream settled - false == true"), "the guard holds"'
    );
    expect(describeLabels([])).toBe('no failing assertion');
    expect(labelRefusal(['the stream closed'], run([xpcshell]))).toBe(
      'expected "the stream closed"; the run was red at "test_wire_three_streams" (assertion "the stream settled - false == true")'
    );
  });

  it('holds each repetition to every label, and counts an unexpected pass for nobody', () => {
    const unexpectedPass = { ...xpcshell, status: 'PASS', expected: 'FAIL' };
    expect(labelRefusal(['the stream settled'], run([xpcshell], [unexpectedPass]))).toMatch(
      /repetition 2/
    );
    expect(labelRefusal(['the stream settled'], run([xpcshell]))).toBeUndefined();
  });
});
