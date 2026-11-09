// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  type AssertionResult,
  controlLabelRefusal,
  describeLabels,
  judgeControlLabels,
  matchesLabel,
} from '../control-assertions.js';

const xpcshell: AssertionResult = {
  assertion: 'test_wire_three_streams',
  status: 'FAIL',
  expected: 'PASS',
  message: 'the stream settled - false == true',
};
const mochitest: AssertionResult = {
  assertion: 'the guard holds',
  status: 'FAIL',
  expected: 'PASS',
};

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
    expect(judgeControlLabels(['the stream settled'], [xpcshell]).matched).toBe(true);
    expect(judgeControlLabels(['the stream settled'], [xpcshell, mochitest])).toMatchObject({
      matched: false,
      unrelated: [mochitest],
    });
    expect(judgeControlLabels(['elsewhere'], [xpcshell])).toMatchObject({
      matched: false,
      missing: ['elsewhere'],
    });
    expect(judgeControlLabels([], []).matched).toBe(false);
  });

  it('names every label a red carried, so a refusal can be copied into --expect', () => {
    expect(describeLabels([xpcshell, mochitest])).toBe(
      '"test_wire_three_streams" (assertion "the stream settled - false == true"), "the guard holds"'
    );
    expect(describeLabels([])).toBe('no failing assertion');
    expect(
      controlLabelRefusal(
        ['the stream closed'],
        [{ run: 1, unexpectedAssertionResults: [xpcshell] }]
      )
    ).toBe(
      'Negative control failed at an unexpected assertion: expected "the stream closed"; the reds were labelled "test_wire_three_streams" (assertion "the stream settled - false == true")'
    );
  });

  it('holds each repeat to every label, and passes an unexpected pass to nobody', () => {
    const files = [
      { run: 1, unexpectedAssertionResults: [xpcshell] },
      { run: 2, unexpectedAssertionResults: [{ ...xpcshell, status: 'PASS', expected: 'FAIL' }] },
    ];
    expect(controlLabelRefusal(['the stream settled'], files)).toMatch(/lacks intended failing/);
    expect(controlLabelRefusal(['the stream settled'], files.slice(0, 1))).toBeUndefined();
  });
});
