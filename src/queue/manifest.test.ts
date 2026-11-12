// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  categoryOf,
  formatManifest,
  type Manifest,
  manifestProblems,
  parseManifest,
  type PatchEntry,
  patchFilename,
} from './manifest.js';

const ESR = { product: 'firefox-esr' as const, version: '140.9.0esr' };
const NEXT = { product: 'firefox-esr' as const, version: '141.0esr' };

function entry(order: number, name: string, extra: Partial<PatchEntry> = {}): PatchEntry {
  return { order, name, description: '', firefox: ESR, ...extra };
}

describe('derived names', () => {
  it.each([
    [{ order: 1, name: 'ui-sidebar' }, '001-ui-sidebar.patch'],
    [{ order: 42, name: 'branding' }, '042-branding.patch'],
    [{ order: 1234, name: 'infra-ci-hooks' }, '1234-infra-ci-hooks.patch'],
  ])('%j is stored in %s', (input, filename) => {
    expect(patchFilename(input)).toBe(filename);
  });

  it.each([
    ['ui-sidebar', 'ui'],
    ['branding', 'branding'],
    ['infra-ci-hooks', 'infra'],
  ])('%s is in category %s', (name, category) => {
    expect(categoryOf(name)).toBe(category);
  });
});

describe('formatManifest', () => {
  it('writes keys in a fixed order, rows by order, and hoists the common stamp', () => {
    const manifest: Manifest = {
      patches: [
        entry(2, 'ui-b', { firefox: NEXT, tier: 'branding', description: 'Second' }),
        entry(1, 'ui-a', { lintIgnore: ['large-patch-lines'] }),
        entry(3, 'ui-c'),
      ],
      retired: [{ order: 9, name: 'ui-old', reason: 'merged' }],
    };
    expect(formatManifest(manifest)).toBe(
      `${JSON.stringify(
        {
          version: 2,
          firefox: ESR,
          patches: [
            { order: 1, name: 'ui-a', lintIgnore: ['large-patch-lines'] },
            { order: 2, name: 'ui-b', description: 'Second', firefox: NEXT, tier: 'branding' },
            { order: 3, name: 'ui-c' },
          ],
          retired: [{ order: 9, name: 'ui-old', reason: 'merged' }],
        },
        null,
        2
      )}\n`
    );
  });

  it('round-trips through parseManifest', () => {
    const manifest: Manifest = {
      source: { snapshot: 'abc' },
      patches: [
        entry(1, 'ui-a', {
          stagedDependencies: [{ file: 'jar.mn', creates: 'x.js', reason: 'staged' }],
          lintIgnore: [{ rule: 'large-patch-files', max: 9, reason: 'one unit', share: 'product' }],
        }),
        entry(5, 'ui-b', { firefox: NEXT }),
      ],
      retired: [],
    };
    const parsed = parseManifest(JSON.parse(formatManifest(manifest)), 'patches.json');
    expect(parsed).toEqual({
      manifest,
      files: ['001-ui-a.patch', '005-ui-b.patch'],
    });
  });
});

describe('parseManifest', () => {
  it.each([
    [
      'duplicate orders',
      {
        version: 2,
        firefox: ESR,
        patches: [
          { order: 1, name: 'ui-a' },
          { order: 1, name: 'ui-b' },
        ],
      },
      'share order 1',
    ],
    [
      'duplicate names',
      {
        version: 2,
        firefox: ESR,
        patches: [
          { order: 1, name: 'ui-a' },
          { order: 2, name: 'ui-a' },
        ],
      },
      'two patches are named ui-a',
    ],
    [
      'a retired order a patch holds',
      {
        version: 2,
        firefox: ESR,
        patches: [{ order: 1, name: 'ui-a' }],
        retired: [{ order: 1, name: 'ui-x' }],
      },
      'retired order 1',
    ],
    ['a bad name', { version: 2, firefox: ESR, patches: [{ order: 1, name: 'UI_A' }] }, 'name'],
    ['a missing stamp', { version: 2, patches: [{ order: 1, name: 'ui-a' }] }, 'no Firefox stamp'],
    [
      'an unknown key',
      { version: 2, firefox: ESR, patches: [{ order: 1, name: 'ui-a', filesAffected: [] }] },
      'not a known key',
    ],
  ])('refuses %s', (_label, document, message) => {
    expect(() => parseManifest(document, 'patches.json')).toThrow(message);
  });

  it('converts a version-1 manifest: names from filenames, flat staged dependencies, stamps, retired slots', () => {
    const v1 = {
      version: 1,
      patches: [
        {
          filename: '002-ui-sidebar.patch',
          order: 2,
          category: 'ui',
          name: 'sidebar',
          description: 'Sidebar',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          sourceProduct: 'firefox-esr',
          sourceVersion: '140.9.0esr',
          filesAffected: ['browser/sidebar.js'],
          stagedDependencies: {
            forwardImports: [
              { file: 'a.js', specifier: './b.js', creates: 'b.js', owner: '003-ui-helper.patch' },
            ],
            registrations: [
              { file: 'jar.mn', line: 'content/b.js', creates: 'b.js', reason: 'staged' },
              { file: 'a.js', line: 'duplicate', creates: 'b.js' },
            ],
          },
        },
        {
          filename: '001-branding-identity.patch',
          order: 1,
          category: 'branding',
          name: 'identity',
          description: 'Identity',
          createdAt: '2026-01-01T00:00:00.000Z',
          sourceEsrVersion: '139.0esr',
          filesAffected: [],
          tier: 'branding',
        },
      ],
      retired: [
        {
          order: 7,
          category: 'ui',
          filename: '007-ui-old.patch',
          retiredAt: 'x',
          reason: 'merged',
        },
      ],
      reserved: [{ order: 8, category: 'ui', owner: 'someone', reservedAt: 'x' }],
    };
    const parsed = parseManifest(v1, 'patches.json');
    expect(parsed.files).toEqual(['001-branding-identity.patch', '002-ui-sidebar.patch']);
    expect(parsed.manifest).toEqual({
      patches: [
        {
          order: 1,
          name: 'branding-identity',
          description: 'Identity',
          firefox: { product: 'firefox-esr', version: '139.0esr' },
          tier: 'branding',
        },
        {
          order: 2,
          name: 'ui-sidebar',
          description: 'Sidebar',
          firefox: ESR,
          stagedDependencies: [
            { file: 'a.js', creates: 'b.js' },
            { file: 'jar.mn', creates: 'b.js', reason: 'staged' },
          ],
        },
      ],
      retired: [{ order: 7, name: 'ui-old', reason: 'merged' }],
    });
  });

  it('refuses a version-1 row whose category is not the first word of its name', () => {
    const v1 = {
      version: 1,
      patches: [
        {
          filename: '001-ui-core-a.patch',
          order: 1,
          category: 'ui-core',
          name: 'a',
          sourceEsrVersion: '140.9.0esr',
        },
      ],
    };
    expect(() => parseManifest(v1, 'patches.json')).toThrow('first word');
  });
});

describe('manifestProblems', () => {
  it('accepts a consistent manifest', () => {
    expect(
      manifestProblems({ patches: [entry(1, 'ui-a'), entry(2, 'ui-b')], retired: [] })
    ).toEqual([]);
  });
});
