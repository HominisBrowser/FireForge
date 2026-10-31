// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { LintIgnoreEntry, PatchLintIssue } from '../../types/commands/index.js';
import {
  addedLintIgnoreEntries,
  buildLintIgnoreChecks,
  evaluateLintIgnoreCeilings,
  evaluateLintIgnoreWaivers,
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
      '"fireforge patch lint-ignore 001-ui-x.patch --remove large-patch-lines --yes"'
    );
    expect(evaluateLintIgnoreCeilings(undefined, [], measurements)).toEqual([]);
  });
});

describe('share-scoped ceilings, meta and notices', () => {
  const shared = (share: 'test' | 'product', max: number): LintIgnoreEntry => ({
    rule: 'large-patch-lines',
    max,
    reason: 'reviewed',
    share,
  });
  const sized = (
    measurement: number,
    share: 'test' | 'product',
    severity: PatchLintIssue['severity'] = 'warning'
  ): PatchLintIssue => ({ ...issue('large-patch-lines', measurement, severity), share });

  it('accepts one ceiling per share and preserves meta verbatim', () => {
    const meta = { kind: 'structural', owner: 'tiles', exit: { when: 'split' } };
    const entries = parseLintIgnoreEntries(
      [
        { rule: 'large-patch-lines', max: 900, reason: 'r', share: 'product', meta },
        { rule: 'large-patch-lines', max: 4000, reason: 'r', share: 'test' },
      ],
      'lintIgnore'
    );
    expect(entries[0]).toEqual({
      rule: 'large-patch-lines',
      max: 900,
      reason: 'r',
      share: 'product',
      meta,
    });
    expect(formatLintIgnoreList(entries)).toBe(
      'large-patch-lines[product]<=900, large-patch-lines[test]<=4000'
    );
  });

  it('refuses share on other rules, a bad share or meta, and share clashes', () => {
    const parse = (raw: unknown[]): unknown => parseLintIgnoreEntries(raw, 'lintIgnore');
    expect(() => parse([{ rule: 'file-too-large', max: 1, reason: 'r', share: 'test' }])).toThrow(
      /share must be/
    );
    expect(() =>
      parse([{ rule: 'large-patch-lines', max: 1, reason: 'r', share: 'docs' }])
    ).toThrow(/share must be/);
    expect(() => parse([{ rule: 'file-too-large', max: 1, reason: 'r', meta: [] }])).toThrow(
      /meta must be a JSON object/
    );
    expect(() =>
      parse([
        { rule: 'large-patch-lines', max: 1, reason: 'r' },
        { rule: 'large-patch-lines', max: 1, reason: 'r', share: 'test' },
      ])
    ).toThrow(/one ceiling per share/);
    expect(() =>
      parse([
        { rule: 'large-patch-lines', max: 1, reason: 'r', share: 'test' },
        { rule: 'large-patch-lines', max: 2, reason: 'r', share: 'test' },
      ])
    ).toThrow(/more than once/);
  });

  it('matches each finding to its share, falling back to a share-less ceiling', () => {
    const checks = buildLintIgnoreChecks([shared('product', 900), shared('test', 4000)]);
    const { kept, suppressed } = partitionLintIgnoredIssues(
      [sized(850, 'product'), sized(3500, 'test'), sized(950, 'product')],
      checks
    );
    expect(suppressed.map((entry) => entry.measurement)).toEqual([850, 3500]);
    expect(kept[0]?.message).toContain('ceiling for large-patch-lines (product share)');

    const plain = buildLintIgnoreChecks([ceiling('large-patch-lines', 1000)]);
    expect(isLintIgnored(sized(900, 'test'), plain)).toBe(true);
  });

  it('never counts a notice past the ceiling as exceeding it', () => {
    const checks = buildLintIgnoreChecks([ceiling('large-patch-lines', 500)]);
    const notice = sized(800, 'test', 'notice');
    expect(partitionLintIgnoredIssues([notice], checks).kept).toEqual([notice]);
    expect(
      evaluateLintIgnoreCeilings(
        [ceiling('large-patch-lines', 500)],
        [sized(450, 'product'), notice],
        { lines: 1250, files: 3 }
      )
    ).toEqual([
      {
        rule: 'large-patch-lines',
        max: 500,
        reason: 'reviewed',
        measurement: 800,
        state: 'within',
      },
    ]);
  });

  it('evaluates share ceilings on their own share and reports every waiver', () => {
    const entries: LintIgnoreEntry[] = [
      'raw-color-value',
      { rule: 'large-patch-lines', max: 4000, reason: 'reviewed', share: 'test', meta: { k: 1 } },
      shared('product', 900),
    ];
    const findings = [
      sized(3500, 'test'),
      sized(950, 'product'),
      issue('raw-color-value', undefined),
    ];
    const measurements = { lines: 4450, files: 9 };
    expect(evaluateLintIgnoreCeilings(entries, findings, measurements)).toEqual([
      {
        rule: 'large-patch-lines',
        max: 4000,
        reason: 'reviewed',
        share: 'test',
        meta: { k: 1 },
        measurement: 3500,
        state: 'within',
      },
      {
        rule: 'large-patch-lines',
        max: 900,
        reason: 'reviewed',
        share: 'product',
        measurement: 950,
        state: 'exceeded',
      },
    ]);
    expect(evaluateLintIgnoreWaivers(entries, findings, measurements)[0]).toEqual({
      kind: 'bare',
      rule: 'raw-color-value',
      max: null,
      reason: null,
      measurement: null,
      state: 'within',
    });
    expect(evaluateLintIgnoreWaivers(['large-patch-lines'], [], measurements)[0]).toMatchObject({
      kind: 'bare',
      measurement: 4450,
      state: 'removable',
    });
    expect(evaluateLintIgnoreWaivers(entries, findings, measurements)[2]).toMatchObject({
      kind: 'ceiling',
      share: 'product',
      state: 'exceeded',
    });
  });

  it('upserts a share ceiling beside the other share and over a bare entry', () => {
    expect(
      upsertLintIgnoreEntries(['large-patch-lines', shared('test', 1)], [shared('product', 900)])
    ).toEqual([shared('product', 900), shared('test', 1)]);
    expect(upsertLintIgnoreEntries([shared('test', 1)], [shared('test', 2)])).toEqual([
      shared('test', 2),
    ]);
    expect(
      upsertLintIgnoreEntries([shared('test', 1), shared('product', 2)], ['large-patch-lines'])
    ).toEqual(['large-patch-lines']);
    expect(
      mergeLintIgnoreIds([shared('test', 1), shared('product', 2)], ['large-patch-lines'])
    ).toEqual([shared('test', 1), shared('product', 2)]);
  });

  it('treats a changed meta as a new entry', () => {
    const before: LintIgnoreEntry[] = [
      { rule: 'file-too-large', max: 9, reason: 'r', meta: { a: 1 } },
    ];
    const after: LintIgnoreEntry[] = [
      { rule: 'file-too-large', max: 9, reason: 'r', meta: { a: 2 } },
    ];
    expect(addedLintIgnoreEntries(before, after)).toEqual(after);
    expect(addedLintIgnoreEntries(before, before)).toEqual([]);
  });
});
