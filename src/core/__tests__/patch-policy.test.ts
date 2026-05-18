// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { PatchesManifest, PatchMetadata } from '../../types/commands/index.js';
import type { FireForgeConfig } from '../../types/config.js';
import {
  allocatePolicyOrder,
  evaluatePatchPolicy,
  getPatchPolicyCategories,
  isCategoryAllowedByConfig,
} from '../patch-policy.js';

function config(overrides: Partial<FireForgeConfig> = {}): FireForgeConfig {
  return {
    name: 'MyBrowser',
    vendor: 'Acme',
    appId: 'org.acme.browser',
    binaryName: 'mybrowser',
    firefox: { version: '140.9.0esr', product: 'firefox-esr' },
    ...overrides,
  };
}

function policyConfig(
  extra: Partial<NonNullable<FireForgeConfig['patchPolicy']>> = {}
): FireForgeConfig {
  return config({
    patchPolicy: {
      requireDescription: true,
      ranges: [
        { from: 1, to: 99, category: 'branding' },
        { from: 100, to: 199, category: 'infra' },
        { from: 200, to: 299, category: 'ui' },
      ],
      reservedRanges: [
        {
          from: 900,
          to: 999,
          allowed: [
            {
              filename: '900-infra-bootstrap-workaround.patch',
              files: ['tools/profiler/rust-api/build.rs'],
              adr: 'docs/architecture/adr/0001-bootstrap-workaround.md',
            },
            {
              filename: '901-infra-undocumented.patch',
              files: ['tools/undocumented.js'],
            },
          ],
        },
      ],
      ...extra,
    },
  });
}

function patch(overrides: Partial<PatchMetadata> = {}): PatchMetadata {
  return {
    filename: '200-ui-toolbar.patch',
    order: 200,
    category: 'ui',
    name: 'toolbar',
    description: 'Toolbar work',
    createdAt: '2026-01-01T00:00:00.000Z',
    sourceEsrVersion: '140.9.0esr',
    filesAffected: ['browser/base/content/browser.js'],
    ...overrides,
  };
}

function manifest(patches: PatchMetadata[]): PatchesManifest {
  return { version: 1, patches };
}

describe('patch policy evaluation', () => {
  it('is a no-op when patchPolicy is absent', () => {
    expect(
      evaluatePatchPolicy(
        config(),
        manifest([patch({ filename: '900-ui-late-product.patch', order: 900 })])
      )
    ).toEqual([]);
  });

  it('reports category/range mismatches on structurally valid patches', () => {
    const issues = evaluatePatchPolicy(
      policyConfig(),
      manifest([patch({ filename: '900-ui-late-product.patch', order: 900 })])
    );

    expect(issues.map((issue) => issue.code)).toContain('reserved-range');
    expect(issues[0]?.message).toContain('reserved range 900-999');
  });

  it('allows documented reserved exceptions with allowlisted files', () => {
    const issues = evaluatePatchPolicy(
      policyConfig(),
      manifest([
        patch({
          filename: '900-infra-bootstrap-workaround.patch',
          order: 900,
          category: 'infra',
          filesAffected: ['tools/profiler/rust-api/build.rs'],
        }),
      ])
    );

    expect(issues).toEqual([]);
  });

  it('reports missing reserved documentation and files outside the allowlist', () => {
    const issues = evaluatePatchPolicy(
      policyConfig(),
      manifest([
        patch({
          filename: '901-infra-undocumented.patch',
          order: 901,
          category: 'infra',
          filesAffected: ['tools/undocumented.js', 'browser/base/content/browser.js'],
        }),
      ])
    );

    expect(issues.map((issue) => issue.code)).toEqual(['reserved-documentation', 'reserved-files']);
  });

  it('reports filename capture mismatches and empty descriptions', () => {
    const issues = evaluatePatchPolicy(
      policyConfig(),
      manifest([
        patch({
          filename: '200-ui-toolbar.patch',
          order: 201,
          category: 'infra',
          description: '   ',
        }),
      ])
    );

    expect(issues.map((issue) => issue.code)).toEqual([
      'filename-metadata-mismatch',
      'description-required',
      'category-range',
    ]);
  });

  it('reports intra-range gaps when allowGaps is false', () => {
    const issues = evaluatePatchPolicy(
      policyConfig({ allowGaps: false, requireDescription: false }),
      manifest([
        patch({ filename: '200-ui-a.patch', order: 200, name: 'a' }),
        patch({ filename: '202-ui-c.patch', order: 202, name: 'c' }),
      ])
    );

    expect(issues.map((issue) => issue.code)).toContain('numeric-gap');
    expect(issues.at(-1)?.message).toContain('201');
  });

  it('allocates default export numbers inside the configured category range', () => {
    expect(allocatePolicyOrder(policyConfig(), [patch()], 'ui')).toBe(201);
    expect(allocatePolicyOrder(policyConfig(), [], 'infra')).toBe(100);
  });

  it('uses policy categories for category validation', () => {
    const cfg = policyConfig({
      ranges: [{ from: 1, to: 9, category: 'bootstrap' }],
      reservedRanges: [],
    });

    expect(getPatchPolicyCategories(cfg)).toEqual(['bootstrap']);
    expect(isCategoryAllowedByConfig(cfg, 'bootstrap')).toBe(true);
    expect(isCategoryAllowedByConfig(cfg, 'ui')).toBe(false);
  });
});
