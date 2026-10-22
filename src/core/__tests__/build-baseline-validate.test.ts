// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  describeBuildBaselineProblem,
  findBuildBaselineProblem,
  isBuildBaseline,
  isCoverageProblem,
} from '../build-baseline-validate.js';

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

describe('findBuildBaselineProblem', () => {
  it('returns undefined for a valid baseline', () => {
    expect(findBuildBaselineProblem({ ...BASE, testPackagingCoverage: 'full' })).toBeUndefined();
  });

  it.each([
    [{ testPackagingCoverage: ['a/test', 'b/test/'] }, 'testPackagingCoverage[1]', 'b/test/', true],
    [
      { testCoverageRecords: { 'a/': { ...ANCHOR, inputs: [] } } },
      'testCoverageRecords["a/"]',
      'a/',
      true,
    ],
    [
      { testCoverageRecords: { 'a/test': { ...ANCHOR, inputs: ['./x'] } } },
      'testCoverageRecords["a/test"].inputs',
      './x',
      true,
    ],
    [
      { packageableFingerprints: { 'a\\b.js': HASH } },
      'packageableFingerprints["a\\\\b.js"]',
      'a\\b.js',
      false,
    ],
    [{ binaryName: 'My Browser' }, 'binaryName', 'My Browser', false],
    [{ testInputFingerprints: [] }, 'testInputFingerprints', undefined, false],
    [
      { buildInputFingerprints: { 'a/b.cpp': 'nope' } },
      'buildInputFingerprints["a/b.cpp"]',
      'nope',
      false,
    ],
    [{ testPackagingCoverage: 'a/test' }, 'testPackagingCoverage', 'a/test', true],
    [{ testCoverageRecords: [] }, 'testCoverageRecords', undefined, true],
    [{ mozconfigHash: 'short' }, 'mozconfigHash', 'short', false],
    [{ recordedBy: 7 }, 'recordedBy', 7, false],
    [{ fullCoverageAnchor: 'full' }, 'fullCoverageAnchor', 'full', true],
    [
      { staticComponentsBaseline: { fingerprints: {} } },
      'staticComponentsBaseline',
      undefined,
      false,
    ],
    [{ controlBuild: { diffFile: 'x.diff', targets: [] } }, 'controlBuild', undefined, false],
  ])('names the first failing field of %j', (fields, field, value, coverage) => {
    const problem = findBuildBaselineProblem({ ...BASE, ...fields });
    expect(problem?.field).toBe(field);
    if (value !== undefined) expect(problem?.value).toBe(value);
    expect(problem !== undefined && isCoverageProblem(problem)).toBe(coverage);
  });

  it('names a non-object root', () => {
    expect(findBuildBaselineProblem('x')).toEqual({ field: '(root)', value: 'x' });
  });

  it('renders a bounded value, undefined and an unserializable value', () => {
    expect(describeBuildBaselineProblem({ field: 'a', value: 'b'.repeat(200) })).toBe(
      `a = "${'b'.repeat(116)}...`
    );
    expect(describeBuildBaselineProblem({ field: 'a', value: undefined })).toBe('a = undefined');
    expect(describeBuildBaselineProblem({ field: 'a', value: 1n })).toBe('a = 1');
  });

  it('accepts a well-formed controlBuild stamp', () => {
    expect(
      isBuildBaseline({
        ...BASE,
        controlBuild: {
          diffFile: 'controls/a.diff',
          targets: ['gfx/a.cpp'],
          appliedAt: '2026-10-22T10:00:00.000Z',
        },
      })
    ).toBe(true);
  });
});
