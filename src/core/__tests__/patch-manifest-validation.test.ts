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
            sourceEsrVersion: '140.9.0esr',
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
          sourceEsrVersion: '140.9.0esr',
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
            sourceEsrVersion: '140.9.0esr',
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
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/content/browser.js', 42],
          },
        ],
      })
    ).toThrow('patches[0].filesAffected must be an array of strings');
  });

  it('preserves lintIgnore when present as a string array', () => {
    // Pre-0.17.0 regression: `lintIgnore` was silently stripped on every
    // manifest load because validatePatchMetadata returned a fresh
    // object enumerating only the documented required fields. An
    // operator who added the escape hatch by hand saw their
    // suppression evaporate the next time the validator ran, and
    // the `large-patch-lines` / `large-patch-files` rules they
    // intentionally quieted re-fired without warning.
    const result = validatePatchesManifest({
      version: 1,
      patches: [
        {
          filename: '001-branding-custom.patch',
          order: 1,
          category: 'branding',
          name: 'custom',
          description: 'Custom branding',
          createdAt: '2026-04-21T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/branding/custom/logo.png'],
          lintIgnore: ['large-patch-lines', 'large-patch-files'],
        },
      ],
    });
    expect(result.patches[0]?.lintIgnore).toEqual(['large-patch-lines', 'large-patch-files']);
  });

  it('rejects lintIgnore when present but not a string array', () => {
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
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/base/content/browser.js'],
            lintIgnore: ['ok', 42],
          },
        ],
      })
    ).toThrow('patches[0].lintIgnore must be an array of strings');
  });

  it('omits lintIgnore from the validated output when absent', () => {
    const result = validatePatchesManifest({
      version: 1,
      patches: [
        {
          filename: '001-ui.patch',
          order: 1,
          category: 'ui',
          name: 'ui',
          description: 'UI patch',
          createdAt: '2026-04-07T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    });
    expect('lintIgnore' in (result.patches[0] ?? {})).toBe(false);
  });

  it('preserves tier when present as "branding"', () => {
    // The 0.17.0 explicit branding-threshold opt-in. An operator
    // declaring `tier: "branding"` on a branding patch that also
    // touches a non-allowlisted sibling (e.g. a fork-specific theme
    // override) expects lintPatchSize to apply the branding tier
    // regardless of filesAffected. Schema round-trip is load-bearing
    // for that contract.
    const result = validatePatchesManifest({
      version: 1,
      patches: [
        {
          filename: '001-branding-full.patch',
          order: 1,
          category: 'branding',
          name: 'full',
          description: 'Full branding bundle including theme overrides',
          createdAt: '2026-04-21T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: [
            'browser/branding/custom/logo.png',
            'browser/themes/custom-shared/tokens.css',
          ],
          tier: 'branding',
        },
      ],
    });
    expect(result.patches[0]?.tier).toBe('branding');
  });

  it('rejects unknown tier values with a clear message', () => {
    // Opinionated choice — unknown tier values throw rather than
    // silently strip, matching how category and sourceEsrVersion
    // are handled. A typo like "Branding" (capitalised) should
    // surface as a loader error, not quietly fall back to auto-
    // detection and leave the operator guessing why the rule
    // still fires.
    expect(() =>
      validatePatchesManifest({
        version: 1,
        patches: [
          {
            filename: '001-branding-full.patch',
            order: 1,
            category: 'branding',
            name: 'full',
            description: 'Full branding bundle',
            createdAt: '2026-04-21T00:00:00.000Z',
            sourceEsrVersion: '140.9.0esr',
            filesAffected: ['browser/branding/custom/logo.png'],
            tier: 'Branding',
          },
        ],
      })
    ).toThrow('patches[0].tier must be "branding"');
  });

  it('omits tier from the validated output when absent', () => {
    const result = validatePatchesManifest({
      version: 1,
      patches: [
        {
          filename: '001-ui.patch',
          order: 1,
          category: 'ui',
          name: 'ui',
          description: 'UI patch',
          createdAt: '2026-04-07T00:00:00.000Z',
          sourceEsrVersion: '140.9.0esr',
          filesAffected: ['browser/base/content/browser.js'],
        },
      ],
    });
    expect('tier' in (result.patches[0] ?? {})).toBe(false);
  });
});
