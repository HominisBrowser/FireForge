// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONFIG } from '../../test-utils/index.js';
import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import { describeProjectedGaps } from '../patch/delete-gap-notice.js';

function ui(order: number): PatchMetadata {
  return {
    filename: `${order}-ui-p${order}.patch`,
    order,
    category: 'ui',
    name: `p${order}`,
    description: '',
    createdAt: '2025-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [`ui/p${order}.sys.mjs`],
  };
}

function manifestOf(...orders: number[]): PatchesManifest {
  return { version: 1, patches: orders.map(ui) };
}

function configWith(allowGaps: boolean | undefined): FireForgeConfig {
  return {
    ...DEFAULT_CONFIG,
    patchPolicy: {
      ranges: [{ from: 200, to: 499, category: 'ui' }],
      ...(allowGaps === undefined ? {} : { allowGaps }),
    },
  };
}

describe('describeProjectedGaps', () => {
  it('names the gap and both remedies when the removal opens one', () => {
    const manifest = manifestOf(201, 202, 203);
    const lines = describeProjectedGaps(configWith(false), manifest, ui(202));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      'deleting 202-ui-p202.patch leaves ui range 200-499 with a gap at 202; the queue will ' +
        'fail numeric-gap (patchPolicy.allowGaps is false) until "fireforge export --order 202" ' +
        'fills it or "fireforge patch compact" renumbers.'
    );
  });

  it('reports only gaps the queue does not already have', () => {
    // 205 is already missing; deleting 202 adds a second gap in the same range,
    // so the message changes and is reported once with both orders.
    const manifest = manifestOf(201, 202, 203, 204, 206);
    const lines = describeProjectedGaps(configWith(false), manifest, ui(202));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('a gap at 202, 205');
    expect(lines[0]).toContain('"fireforge export --order 202"');
  });

  it('returns nothing when the last patch of a range is removed', () => {
    expect(describeProjectedGaps(configWith(false), manifestOf(201, 202, 203), ui(203))).toEqual(
      []
    );
  });

  it('returns nothing when gaps are allowed or no policy is configured', () => {
    const manifest = manifestOf(201, 202, 203);
    expect(describeProjectedGaps(configWith(true), manifest, ui(202))).toEqual([]);
    expect(describeProjectedGaps(configWith(undefined), manifest, ui(202))).toEqual([]);
    expect(describeProjectedGaps({ ...DEFAULT_CONFIG }, manifest, ui(202))).toEqual([]);
  });
});
