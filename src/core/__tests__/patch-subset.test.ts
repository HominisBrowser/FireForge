// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import { selectPatchSubset } from '../patch-subset.js';

function meta(filename: string, order: number): PatchMetadata {
  return {
    filename,
    order,
    category: 'ui',
    name: filename.replace(/^\d+-\w+-|\.patch$/g, ''),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
  };
}

const MANIFEST: PatchesManifest = {
  version: 1,
  patches: [
    meta('101-ui-canvas-tiles.patch', 101),
    meta('102-ui-canvas-dock.patch', 102),
    meta('201-ui-window-bar.patch', 201),
  ],
};

describe('selectPatchSubset', () => {
  it('splits a list given as one word on whitespace and commas', () => {
    const selected = selectPatchSubset(MANIFEST, ['101 102\t201', ' 102,  ', '']);
    expect(selected.map((patch) => patch.order)).toEqual([101, 102, 201]);
  });

  it('names the first unmatched name and its nearest matches, not the whole queue', () => {
    let message = '';
    try {
      selectPatchSubset(MANIFEST, ['101 canvas-dok 999'], 'Hint.');
    } catch (error: unknown) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^No patch in the queue matches "canvas-dok"\. Hint\. Did you mean: /);
    expect(message).toContain('Did you mean: canvas-dock?');
    expect(message).toContain('(3 patches in queue');
    expect(message).not.toContain('201-ui-window-bar.patch');
    expect(message).not.toContain('Available patches');
  });
});
