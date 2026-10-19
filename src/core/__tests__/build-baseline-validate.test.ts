// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { isBuildBaseline } from '../build-baseline-validate.js';

const HASH = 'a'.repeat(64);
const BASE = {
  engineHeadSha: 'abc',
  builtAt: '2026-10-01T00:00:00.000Z',
  binaryName: 'mybrowser',
};
const ANCHOR = { engineHeadSha: 'abc', mozconfigHash: HASH, fingerprints: { 'a/b.js': HASH } };

describe('isBuildBaseline per-path coverage fields', () => {
  it('accepts well-formed records and a carried full anchor', () => {
    expect(
      isBuildBaseline({
        ...BASE,
        testPackagingCoverage: ['a/test'],
        testCoverageRecords: { 'a/test': { ...ANCHOR, inputs: ['a/test', 'shared/head.js'] } },
        fullCoverageAnchor: ANCHOR,
        recorder: { pid: 42, invocationId: 'id', sessionId: 'lane-a' },
      })
    ).toBe(true);
  });

  it.each([
    ['a record map that is not an object', { testCoverageRecords: [] }],
    ['an escaping record key', { testCoverageRecords: { '../x': { ...ANCHOR, inputs: [] } } }],
    ['a record without inputs', { testCoverageRecords: { 'a/test': ANCHOR } }],
    ['an escaping input', { testCoverageRecords: { 'a/test': { ...ANCHOR, inputs: ['/abs'] } } }],
    [
      'a record with a malformed fingerprint',
      {
        testCoverageRecords: {
          'a/test': { ...ANCHOR, fingerprints: { 'a/b.js': 'nope' }, inputs: [] },
        },
      },
    ],
    [
      'a full anchor without a mozconfig hash',
      { fullCoverageAnchor: { ...ANCHOR, mozconfigHash: 1 } },
    ],
    [
      'a full anchor with a non-string HEAD',
      { fullCoverageAnchor: { ...ANCHOR, engineHeadSha: 1 } },
    ],
    ['a full anchor that is not an object', { fullCoverageAnchor: 'full' }],
    ['a recorder without an invocation id', { recorder: { pid: 1 } }],
    ['a recorder with a non-integer pid', { recorder: { pid: '1', invocationId: 'x' } }],
  ])('rejects %s', (_label, fields) => {
    expect(isBuildBaseline({ ...BASE, ...fields })).toBe(false);
  });
});
