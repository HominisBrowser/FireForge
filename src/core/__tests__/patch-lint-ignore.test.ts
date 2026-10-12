// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { LintIgnoreEntry, PatchLintIssue } from '../../types/commands/index.js';
import {
  addedLintIgnoreEntries,
  buildLintIgnoreChecks,
  evaluateLintIgnoreCeilings,
  formatLintIgnoreList,
  isLintIgnored,
  lintIgnoreCacheTokens,
  mergeLintIgnoreIds,
  parseLintIgnoreEntries,
  partitionLintIgnoredIssues,
  removableCeilingIssues,
  removeLintIgnoreRules,
  upsertLintIgnoreEntries,
} from '../patch-lint-ignore.js';

const ceiling = (rule: string, max: number, reason = 'reviewed'): LintIgnoreEntry => ({
  rule,
  max,
  reason,
});

function issue(
  check: string,
  measurement: number | undefined,
  severity: PatchLintIssue['severity'] = 'warning'
): PatchLintIssue {
  return {
    file: 'a.sys.mjs',
    check,
    message: `${check} finding.`,
    severity,
    ...(measurement === undefined ? {} : { measurement }),
  };
}

describe('parseLintIgnoreEntries', () => {
  it('accepts bare IDs (any ID, duplicates kept) and ceilings', () => {
    expect(
      parseLintIgnoreEntries(['x', 'x', ceiling('file-too-large', 900)], 'patches[0].lintIgnore')
    ).toEqual(['x', 'x', ceiling('file-too-large', 900)]);
  });

  it('refuses a non-array and a second ceiling for one rule', () => {
    expect(() => parseLintIgnoreEntries('x', 'L')).toThrow('L must be an array');
    expect(() =>
      parseLintIgnoreEntries(
        [ceiling('large-patch-lines', 1), ceiling('large-patch-lines', 2)],
        'L'
      )
    ).toThrow('L names "large-patch-lines" more than once');
    expect(() => parseLintIgnoreEntries([null], 'L')).toThrow('L[0] must be a check ID string');
  });
});

describe('buildLintIgnoreChecks / partitionLintIgnoredIssues', () => {
  it('returns undefined for an empty list, a plain set without ceilings', () => {
    expect(buildLintIgnoreChecks(undefined)).toBeUndefined();
    expect(buildLintIgnoreChecks([])).toBeUndefined();
    const plain = buildLintIgnoreChecks(['a']);
    expect(plain?.has('a')).toBe(true);
    expect(plain?.ceilings).toBeUndefined();
  });

  it('suppresses at or below max, fires past it with the ceiling named, and fails closed', () => {
    const checks = buildLintIgnoreChecks(['raw-color-value', ceiling('file-too-large', 1000, 'r')]);
    const { kept, suppressed } = partitionLintIgnoredIssues(
      [
        issue('raw-color-value', undefined, 'error'),
        issue('file-too-large', 1000),
        issue('file-too-large', 1001),
        issue('file-too-large', undefined),
        issue('missing-jsdoc', undefined),
      ],
      checks
    );
    expect(suppressed.map((i) => [i.check, i.measurement])).toEqual([
      ['raw-color-value', undefined],
      ['file-too-large', 1000],
    ]);
    expect(kept.map((i) => [i.check, i.measurement])).toEqual([
      ['file-too-large', 1001],
      ['file-too-large', undefined],
      ['missing-jsdoc', undefined],
    ]);
    expect(kept[0]?.message).toBe(
      "file-too-large finding. This exceeds the patch's lintIgnore ceiling for file-too-large (max 1000: r)."
    );
    expect(isLintIgnored(issue('file-too-large', 5), checks)).toBe(true);
    expect(isLintIgnored(issue('file-too-large', 5), undefined)).toBe(false);
  });

  it('a plain Set<string> still works as the filter', () => {
    const { kept, suppressed } = partitionLintIgnoredIssues(
      [issue('a', undefined), issue('b', undefined)],
      new Set(['a'])
    );
    expect(suppressed.map((i) => i.check)).toEqual(['a']);
    expect(kept.map((i) => i.check)).toEqual(['b']);
  });

  it('renders cache tokens for bare IDs and ceilings', () => {
    expect(lintIgnoreCacheTokens(undefined)).toEqual([]);
    expect(
      lintIgnoreCacheTokens(buildLintIgnoreChecks(['a', ceiling('large-patch-files', 9)]))
    ).toEqual(['a', 'large-patch-files<=9']);
  });
});

describe('list editing helpers', () => {
  it('mergeLintIgnoreIds unions without widening an existing ceiling', () => {
    expect(mergeLintIgnoreIds(undefined, undefined)).toBeUndefined();
    expect(
      mergeLintIgnoreIds([ceiling('file-too-large', 9), 'a'], ['file-too-large', 'b'])
    ).toEqual([ceiling('file-too-large', 9), 'a', 'b']);
  });

  it('upsertLintIgnoreEntries replaces by rule; removeLintIgnoreRules drops by rule', () => {
    expect(
      upsertLintIgnoreEntries(['file-too-large', 'a'], [ceiling('file-too-large', 9)])
    ).toEqual([ceiling('file-too-large', 9), 'a']);
    expect(upsertLintIgnoreEntries([], [])).toBeUndefined();
    expect(removeLintIgnoreRules([ceiling('file-too-large', 9), 'a'], ['file-too-large'])).toEqual([
      'a',
    ]);
    expect(removeLintIgnoreRules(['a'], ['a'])).toBeUndefined();
  });

  it('addedLintIgnoreEntries treats a moved ceiling as new and an identical one as present', () => {
    const before = [ceiling('file-too-large', 9), 'a'];
    expect(addedLintIgnoreEntries(before, [ceiling('file-too-large', 9), 'a'])).toEqual([]);
    expect(addedLintIgnoreEntries(before, [ceiling('file-too-large', 10), 'a'])).toEqual([
      ceiling('file-too-large', 10),
    ]);
    expect(formatLintIgnoreList([])).toBe('(empty)');
    expect(formatLintIgnoreList(before)).toBe('file-too-large<=9, a');
  });
});

describe('evaluateLintIgnoreCeilings', () => {
  const measurements = { lines: 120, files: 3 };

  it('classifies within / exceeded / removable and skips bare entries', () => {
    const statuses = evaluateLintIgnoreCeilings(
      [
        'raw-color-value',
        ceiling('file-too-large', 1000),
        ceiling('large-patch-lines', 2000),
        ceiling('large-patch-files', 4),
      ],
      [
        issue('file-too-large', 950),
        issue('file-too-large', 1200),
        issue('large-patch-lines', 900, 'notice'),
      ],
      measurements
    );
    expect(statuses).toEqual([
      {
        rule: 'file-too-large',
        max: 1000,
        reason: 'reviewed',
        measurement: 1200,
        state: 'exceeded',
      },
      {
        rule: 'large-patch-lines',
        max: 2000,
        reason: 'reviewed',
        measurement: 900,
        state: 'removable',
      },
      { rule: 'large-patch-files', max: 4, reason: 'reviewed', measurement: 3, state: 'removable' },
    ]);
  });

  it('reports within when a gating finding stays under the ceiling', () => {
    expect(
      evaluateLintIgnoreCeilings(
        [ceiling('file-too-large', 1000)],
        [issue('file-too-large', 800)],
        measurements
      )
    ).toEqual([
      { rule: 'file-too-large', max: 1000, reason: 'reviewed', measurement: 800, state: 'within' },
    ]);
  });

  it('turns removable ceilings into notices naming the removal command', () => {
    const statuses = evaluateLintIgnoreCeilings(
      [ceiling('file-too-large', 1000), ceiling('large-patch-lines', 2000)],
      [],
      measurements
    );
    const notices = removableCeilingIssues('001-ui-x.patch', statuses);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toMatchObject({ check: 'lint-ignore-removable', severity: 'notice' });
    expect(notices[0]?.message).toContain('the measurement is below its notice band');
    expect(notices[1]?.message).toContain('the measurement is at 120');
    expect(notices[1]?.message).toContain(
      'fireforge patch lint-ignore 001-ui-x.patch --remove large-patch-lines'
    );
    expect(evaluateLintIgnoreCeilings(undefined, [], measurements)).toEqual([]);
  });
});
