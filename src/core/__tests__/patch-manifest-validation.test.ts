// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { validatePatchesManifest } from '../patch-manifest.js';

describe('validatePatchesManifest', () => {
  it('accepts a valid patches manifest', () => {
    expect(
      validatePatchesManifest({
        version: 1,
        patches: [
          {
            filename: '001-ui.patch',
            order: 1,
            category: 'ui',
            name: 'ui',
            description: 'UI patch',
            createdAt: '2026-04-07T00:00:00.000Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['browser/base/content/browser.js'],
          },
        ],
      })
    ).toEqual({
      version: 1,
      patches: [
        {
          filename: '001-ui.patch',
          order: 1,
          category: 'ui',
          name: 'ui',
          description: 'UI patch',
          createdAt: '2026-04-07T00:00:00.000Z',
          sourceEsrVersion: '140.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    });
  });

  it('rejects malformed patch metadata with actionable messages', () => {
    expect(() =>
      validatePatchesManifest({
        version: 1,
        patches: [
          {
            filename: '001-ui.patch',
            order: 'first',
            category: 'oops',
            name: 'ui',
            description: 'UI patch',
            createdAt: '2026-04-07T00:00:00.000Z',
            sourceEsrVersion: 'not-a-version',
            filesAffected: ['browser/base/content/browser.js'],
          },
        ],
      })
    ).toThrow('patches[0].order must be a non-negative integer');
  });

  it('rejects unsupported manifest versions and missing patch arrays', () => {
    expect(() => validatePatchesManifest({ version: 2, patches: [] })).toThrow(
      'patches.json version must be 1'
    );
    expect(() => validatePatchesManifest({ version: 1 })).toThrow(
      'patches.json field "patches" must be an array'
    );
  });

  it('rejects invalid categories and non-string filesAffected entries', () => {
    expect(() =>
      validatePatchesManifest({
        version: 1,
        patches: [
          {
            filename: '001-ui.patch',
            order: 1,
            category: '',
            name: 'ui',
            description: 'UI patch',
            createdAt: '2026-04-07T00:00:00.000Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['browser/base/content/browser.js'],
          },
        ],
      })
    ).toThrow('patches[0].category must be one of: branding, ui, privacy, security, infra');

    expect(() =>
      validatePatchesManifest({
        version: 1,
        patches: [
          {
            filename: '001-ui.patch',
            order: 1,
            category: 'ui',
            name: 'ui',
            description: 'UI patch',
            createdAt: '2026-04-07T00:00:00.000Z',
            sourceEsrVersion: '140.0esr',
            filesAffected: ['browser/base/content/browser.js', 42],
          },
        ],
      })
    ).toThrow('patches[0].filesAffected must be an array of strings');
  });
});
