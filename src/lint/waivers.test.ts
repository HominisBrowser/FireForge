// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { ChangeSet, LintIgnoreEntry } from '../project/index.js';
import { textChangeSet } from '../testing/changes.js';
import type { Finding } from './rule.js';
import { applyWaivers } from './waivers.js';

const changes = (lintIgnore: LintIgnoreEntry[], other: LintIgnoreEntry[] = []): ChangeSet =>
  textChangeSet(
    [
      { path: 'browser/a.js', group: 'g', after: 'a\n' },
      { path: 'browser/shared.js', group: 'g', after: 'x\n' },
      { path: 'browser/shared.js', group: 'h', before: 'x\n', after: 'y\n' },
    ],
    [
      { id: 'g', meta: {}, lintIgnore },
      { id: 'h', meta: {}, lintIgnore: other },
    ]
  );

const finding = (overrides: Partial<Finding> = {}): Finding => ({
  rule: 'file-too-large',
  severity: 'warning',
  message: 'Too large.',
  path: 'browser/a.js',
  group: 'g',
  ...overrides,
});

describe('applyWaivers', () => {
  it('drops every finding of a bare waiver and reports it within', () => {
    const outcome = applyWaivers(changes(['file-too-large']), [finding({ measurement: 900 })]);
    expect(outcome.kept).toEqual([]);
    expect(outcome.suppressed).toHaveLength(1);
    expect(outcome.waivers).toEqual([
      expect.objectContaining({ group: 'g', rule: 'file-too-large', max: null, state: 'within' }),
    ]);
  });

  it('holds a ceiling: within at or below max, surfaced and annotated above it, closed without a measurement', () => {
    const ceiling = { rule: 'file-too-large', max: 500, reason: 'generated table' };
    const within = applyWaivers(changes([ceiling]), [finding({ measurement: 500 })]);
    expect(within.kept).toEqual([]);
    expect(within.waivers[0]).toMatchObject({ measurement: 500, state: 'within' });

    const grown = applyWaivers(changes([ceiling]), [finding({ measurement: 501 })]);
    expect(grown.kept).toHaveLength(1);
    expect(grown.kept[0]?.message).toBe(
      'Too large. This exceeds the lintIgnore ceiling for file-too-large (max 500: generated table).'
    );
    expect(grown.waivers[0]).toMatchObject({ state: 'exceeded' });

    const unmeasured = applyWaivers(changes([ceiling]), [finding()]);
    expect(unmeasured.kept).toHaveLength(1);
  });

  it('surfaces a notice past its ceiling unannotated, and marks a ceiling with nothing to waive removable', () => {
    const ceiling = { rule: 'file-too-large', max: 10, reason: 'r' };
    const notice = applyWaivers(changes([ceiling]), [
      finding({ severity: 'notice', measurement: 20 }),
    ]);
    expect(notice.kept.map((kept) => [kept.rule, kept.message])).toEqual([
      ['file-too-large', 'Too large.'],
      [
        'lint-ignore-removable',
        'The lintIgnore ceiling for file-too-large (max 10) is no longer needed: the rule reports nothing at warning or error on g. Remove it.',
      ],
    ]);
    expect(notice.waivers[0]).toMatchObject({ state: 'removable' });
    // A bare waiver that waives nothing is removable too, but adds no notice.
    const bare = applyWaivers(changes(['relative-import']), []);
    expect(bare.waivers[0]).toMatchObject({ state: 'removable' });
    expect(bare.kept).toEqual([]);
  });

  it('matches a ceiling by share, preferring the one naming the finding share', () => {
    const entries: LintIgnoreEntry[] = [
      { rule: 'large-patch-lines', max: 100, reason: 'any' },
      { rule: 'large-patch-lines', max: 10, reason: 'tests', share: 'test' },
    ];
    const outcome = applyWaivers(changes(entries), [
      finding({ rule: 'large-patch-lines', path: undefined, measurement: 50, share: 'test' }),
      finding({ rule: 'large-patch-lines', path: undefined, measurement: 50, share: 'product' }),
    ]);
    expect(outcome.kept.map((kept) => kept.share)).toEqual(['test']);
    expect(outcome.suppressed.map((kept) => kept.share)).toEqual(['product']);
  });

  it('judges a finding against every group with a step on its path', () => {
    const outcome = applyWaivers(changes([], ['relative-import']), [
      finding({ rule: 'relative-import', path: 'browser/shared.js', group: 'g' }),
      finding({ rule: 'relative-import', path: 'browser/a.js', group: 'g' }),
    ]);
    expect(outcome.suppressed.map((kept) => kept.path)).toEqual(['browser/shared.js']);
    expect(outcome.kept.map((kept) => kept.path)).toEqual(['browser/a.js']);
  });
});
