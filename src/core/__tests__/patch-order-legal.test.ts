// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { PatchPolicyConfig } from '../../types/config.js';
import { earliestLegalOrderAfter } from '../patch-order-legal.js';

function ui(order: number): PatchMetadata {
  return {
    filename: `${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: 'd',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
  };
}

function manifestOf(...orders: number[]): PatchesManifest {
  return { version: 1, patches: orders.map(ui) };
}

const RANGES: PatchPolicyConfig['ranges'] = [
  { from: 200, to: 209, category: 'ui' },
  { from: 300, to: 399, category: 'infra' },
];

describe('earliestLegalOrderAfter', () => {
  it('returns the next free order without a policy', () => {
    expect(earliestLegalOrderAfter({}, manifestOf(201, 202, 204), 'ui', 201)).toBe(203);
  });

  it('fills an existing gap first and never opens a new one under allowGaps: false', () => {
    const config = { patchPolicy: { ranges: RANGES, allowGaps: false } };
    expect(earliestLegalOrderAfter(config, manifestOf(201, 202, 204), 'ui', 201)).toBe(203);
    expect(earliestLegalOrderAfter(config, manifestOf(200, 201), 'ui', 201)).toBe(202);
    // Every order past 202 would leave 202 missing.
    expect(earliestLegalOrderAfter(config, manifestOf(200, 201), 'ui', 205)).toBeNull();
  });

  it('allows a gap when the policy does and stays inside the category range', () => {
    const config = { patchPolicy: { ranges: RANGES } };
    expect(earliestLegalOrderAfter(config, manifestOf(200, 201), 'ui', 205)).toBe(206);
    expect(earliestLegalOrderAfter(config, manifestOf(200, 201), 'ui', 209)).toBeNull();
  });

  it('skips reserved orders', () => {
    const config = {
      patchPolicy: {
        ranges: RANGES,
        reservedRanges: [{ from: 203, to: 204, allowed: [] }],
      },
    };
    expect(earliestLegalOrderAfter(config, manifestOf(200, 201, 202), 'ui', 202)).toBe(205);
  });
});
