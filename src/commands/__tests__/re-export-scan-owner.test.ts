// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import {
  assignScanFileOwners,
  joinScanFileOwner,
  scanOptionsForPatch,
  splitScanFileOwner,
  validateScanFileOwners,
} from '../re-export-scan-owner.js';

function row(filename: string): PatchMetadata {
  return {
    filename,
    order: Number.parseInt(filename.slice(0, 3), 10),
    category: 'ui',
    name: filename.slice(7, -6),
    description: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: [],
  };
}

const SHELL = row('200-ui-window-shell.patch');
const TILES = row('201-ui-canvas-tiles.patch');
const OTHER = row('202-ui-other.patch');
const MANIFEST: PatchesManifest = { version: 1, patches: [SHELL, TILES, OTHER] };

describe('splitScanFileOwner', () => {
  it.each([
    ['201:browser/a.js', { owner: '201', path: 'browser/a.js' }],
    ['201-ui-canvas-tiles.patch:a.js', { owner: '201-ui-canvas-tiles.patch', path: 'a.js' }],
    ['browser/a.js', { owner: undefined, path: 'browser/a.js' }],
    ['browser/a:b.js', { owner: undefined, path: 'browser/a:b.js' }],
    [':a.js', { owner: undefined, path: ':a.js' }],
    [' :a.js', { owner: undefined, path: ' :a.js' }],
    ['C:/engine/a.js', { owner: undefined, path: 'C:/engine/a.js' }],
    ['C:\\engine\\a.js', { owner: undefined, path: 'C:\\engine\\a.js' }],
  ])('splits %s', (raw, expected) => {
    expect(splitScanFileOwner(raw)).toEqual(expected);
  });

  it('round-trips through joinScanFileOwner', () => {
    expect(joinScanFileOwner(splitScanFileOwner('201:a.js'))).toBe('201:a.js');
    expect(joinScanFileOwner(splitScanFileOwner('a.js'))).toBe('a.js');
  });
});

describe('validateScanFileOwners', () => {
  it('accepts unprefixed paths for a single target patch', () => {
    expect(() => {
      validateScanFileOwners(['201'], ['a.js']);
    }).not.toThrow();
  });

  it('requires an owner on every path in a multi-patch call', () => {
    expect(() => {
      validateScanFileOwners(['201', '200'], ['201:a.js', 'b.js']);
    }).toThrow(/--scan-file 201:b\.js.*Missing an owner: b\.js/s);
    expect(() => {
      validateScanFileOwners(['201', '200'], ['201:a.js', '200:b.js']);
    }).not.toThrow();
  });

  it('requires target patches', () => {
    expect(() => {
      validateScanFileOwners([], ['201:a.js']);
    }).toThrow('needs explicit target patch identifiers');
  });
});

describe('assignScanFileOwners', () => {
  it('returns undefined without --scan-file', () => {
    expect(assignScanFileOwners(undefined, [SHELL], MANIFEST)).toBeUndefined();
  });

  it('assigns unprefixed paths to the single selected patch', () => {
    expect(assignScanFileOwners(['b.js', 'a.js'], [TILES], MANIFEST)).toEqual(
      new Map([[TILES.filename, ['a.js', 'b.js']]])
    );
  });

  it('groups owned paths by resolved patch and de-duplicates', () => {
    const assigned = assignScanFileOwners(
      ['201:b.js', '201-ui-canvas-tiles.patch:a.js', '201:a.js', '200:c.js'],
      [SHELL, TILES],
      MANIFEST
    );
    expect(assigned).toEqual(
      new Map([
        [TILES.filename, ['a.js', 'b.js']],
        [SHELL.filename, ['c.js']],
      ])
    );
  });

  it('refuses an unprefixed path among several selected patches', () => {
    expect(() => assignScanFileOwners(['a.js'], [SHELL, TILES], MANIFEST)).toThrow(
      'must name its owning patch'
    );
  });

  it('refuses unknown and unselected owners and double assignment', () => {
    expect(() => assignScanFileOwners(['999:a.js'], [SHELL], MANIFEST)).toThrow('--scan-file');
    expect(() => assignScanFileOwners(['202:a.js'], [SHELL, TILES], MANIFEST)).toThrow(
      '202-ui-other.patch is not among the selected patches'
    );
    expect(() => assignScanFileOwners(['200:a.js', '201:a.js'], [SHELL, TILES], MANIFEST)).toThrow(
      'assigned to more than one patch: a.js'
    );
  });
});

describe('scanOptionsForPatch', () => {
  const options = { scan: true, scanFiles: ['201:a.js'], refuseForeignDrift: true };
  const assignments = new Map([[TILES.filename, ['a.js']]]);

  it('passes options through without assignments', () => {
    expect(scanOptionsForPatch(options, SHELL.filename, undefined)).toBe(options);
  });

  it('gives an assigned patch exactly its files', () => {
    expect(scanOptionsForPatch(options, TILES.filename, assignments)).toEqual({
      ...options,
      scanFiles: ['a.js'],
    });
  });

  it('runs an unassigned patch scan-less with the belts kept', () => {
    expect(scanOptionsForPatch(options, SHELL.filename, assignments)).toEqual({
      scan: false,
      refuseForeignDrift: true,
    });
  });
});
