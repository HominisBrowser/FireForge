// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchPolicyConfig } from '../config/index.js';
import type { PatchEntry, RetiredSlot } from './manifest.js';
import {
  compactOrders,
  nextOrder,
  place,
  type Placement,
  policyProblems,
  type Slots,
} from './placement.js';

const STAMP = { product: 'firefox-esr' as const, version: '140.9.0esr' };

function rows(...specs: Array<[number, string]>): PatchEntry[] {
  return specs.map(([order, name]) => ({ order, name, description: 'd', firefox: STAMP }));
}

function policy(fields: Partial<PatchPolicyConfig> = {}): PatchPolicyConfig {
  return {
    requireDescription: false,
    allowGaps: true,
    mutationMode: 'error',
    verifyDocumentPaths: false,
    ranges: [
      { from: 1, to: 99, category: 'branding' },
      { from: 100, to: 199, category: 'ui' },
    ],
    ...fields,
  };
}

describe('policyProblems', () => {
  it.each<[string, PatchEntry[], RetiredSlot[], Partial<PatchPolicyConfig>, string[]]>([
    ['a compliant queue', rows([1, 'branding-a'], [100, 'ui-b']), [], {}, []],
    [
      'a patch outside its range',
      rows([5, 'ui-b']),
      [],
      {},
      ['005-ui-b.patch: ui patches have 100-199, and order 5 is in the branding range 1-99'],
    ],
    [
      'an unknown category',
      rows([300, 'infra-c']),
      [],
      {},
      ['300-infra-c.patch: infra patches have no range, and order 300 is outside every range'],
    ],
    [
      'a reserved range that does not list the patch',
      rows([950, 'ui-x']),
      [],
      { reservedRanges: [{ from: 900, to: 999, allowed: [{ filename: '950-ui-y.patch' }] }] },
      ['950-ui-x.patch is in the reserved range 900-999, which does not list it'],
    ],
    [
      'a gap, where a retired slot is no gap',
      rows([100, 'ui-a'], [103, 'ui-b']),
      [{ order: 101, name: 'ui-old' }],
      { allowGaps: false },
      ['the ui range 100-199 has gaps at 102 (patchPolicy.allowGaps is false)'],
    ],
    [
      'a missing description and a filename the pattern refuses',
      [{ order: 100, name: 'ui-a', description: ' ', firefox: STAMP }],
      [],
      { requireDescription: true, filenamePattern: '^\\d{3}-ui-[a-z]+-[a-z]+\\.patch$' },
      [
        '100-ui-a.patch does not match patchPolicy.filenamePattern',
        '100-ui-a.patch has no description (patchPolicy.requireDescription)',
      ],
    ],
  ])('reports %s', (_label, patches, retired, fields, expected) => {
    expect(policyProblems(policy(fields), patches, retired)).toEqual(expected);
  });

  it('reports nothing without a policy', () => {
    expect(policyProblems(undefined, rows([5, 'ui-b']), [])).toEqual([]);
  });
});

describe('nextOrder', () => {
  const ui = rows([1, 'ui-a'], [7, 'ui-b']);
  it.each<[string, PatchPolicyConfig | undefined, Slots, number]>([
    ['the end of the queue', undefined, { patches: ui, retired: [] }, 8],
    ['past a retired slot', undefined, { patches: ui, retired: [{ order: 8, name: 'ui-x' }] }, 9],
    [
      'an empty range from its start',
      policy(),
      { patches: rows([1, 'branding-a']), retired: [] },
      100,
    ],
    [
      'after the last patch in range',
      policy(),
      { patches: rows([1, 'branding-a'], [104, 'ui-a']), retired: [] },
      105,
    ],
  ])('gives %s', (_label, config, slots, expected) => {
    expect(nextOrder(config, slots, 'ui')).toBe(expected);
  });

  it('refuses a category without a range and a full range', () => {
    expect(() => nextOrder(policy(), { patches: [], retired: [] }, 'infra')).toThrow(
      expect.objectContaining({ code: 'queue-category-unknown' })
    );
    const full = policy({ ranges: [{ from: 1, to: 2, category: 'ui' }] });
    expect(() => nextOrder(full, { patches: rows([2, 'ui-b']), retired: [] }, 'ui')).toThrow(
      expect.objectContaining({ code: 'queue-range-full' })
    );
  });
});

describe('place', () => {
  /** "1 a, 2 b" as rows. */
  const slotsOf = (text: string): Slots => ({
    patches: text.split(', ').map((spec) => {
      const [order = '', name = ''] = spec.split(' ');
      return { order: Number(order), name };
    }),
    retired: [],
  });

  it.each<[string, string, string, Placement, string]>([
    ['a free order', '1 a, 2 b, 3 c', 'c', { order: 9 }, '1 a, 2 b, 9 c'],
    [
      'an occupied order, moving the run above',
      '1 a, 2 b, 3 c',
      'c',
      { order: 1 },
      '1 c, 2 a, 3 b',
    ],
    ['the free order before', '1 a, 5 b, 9 c', 'c', { before: 'b' }, '1 a, 4 c, 5 b'],
    [
      'before a patch with no free order below',
      '1 a, 2 b, 3 c',
      'c',
      { before: 'b' },
      '1 a, 2 c, 3 b',
    ],
    ['after a patch', '1 a, 2 b, 3 c', 'a', { after: 'b' }, '2 b, 3 a, 4 c'],
  ])('takes %s', (_label, queue, name, placement, expected) => {
    const slots = slotsOf(queue);
    place(slots, name, placement);
    const sorted = slots.patches.sort((x, y) => x.order - y.order);
    expect(sorted.map((row) => `${row.order} ${row.name}`).join(', ')).toBe(expected);
  });

  it('takes over a retired slot asked for by order, and moves one in a run', () => {
    const slots = {
      patches: [
        { order: 1, name: 'a' },
        { order: 3, name: 'b' },
      ],
      retired: [{ order: 2, name: 'old' }],
    };
    place(slots, 'b', { order: 2 });
    expect(slots).toEqual({
      patches: [
        { order: 1, name: 'a' },
        { order: 2, name: 'b' },
      ],
      retired: [],
    });
    const run = {
      patches: [
        { order: 1, name: 'a' },
        { order: 3, name: 'c' },
        { order: 5, name: 'd' },
      ],
      retired: [{ order: 2, name: 'old' }],
    };
    place(run, 'd', { order: 1 });
    expect(run.patches.map((row) => row.order)).toEqual([2, 4, 1]);
    expect(run.retired).toEqual([{ order: 3, name: 'old' }]);
  });
});

describe('compactOrders', () => {
  it('numbers from 1 without a policy and per range with one', () => {
    const plain = { patches: rows([4, 'ui-a'], [9, 'ui-b']), retired: [{ order: 6, name: 'x' }] };
    compactOrders(undefined, plain);
    expect(plain.patches.map((row) => row.order)).toEqual([1, 2]);
    expect(plain.retired).toEqual([]);

    const ranged = {
      patches: rows(
        [3, 'branding-a'],
        [8, 'branding-b'],
        [130, 'ui-c'],
        [131, 'branding-stray'],
        [150, 'ui-d']
      ),
      retired: [{ order: 140, name: 'ui-old' }],
    };
    compactOrders(policy(), ranged);
    expect(ranged.patches.map((row) => `${row.order} ${row.name}`)).toEqual([
      '3 branding-a',
      '4 branding-b',
      '130 ui-c',
      '131 branding-stray',
      '132 ui-d',
    ]);
    expect(ranged.retired).toEqual([]);
  });
});
