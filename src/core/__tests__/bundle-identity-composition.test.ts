// SPDX-License-Identifier: EUPL-1.2
/**
 * The doubled macOS bundle id must be closed for good.
 *
 * The two halves of the identity are written by two different modules —
 * `branding.ts` puts the LEAF in `MOZ_MACBUNDLE_ID`, `mach-mozconfig.ts`
 * puts the PREFIX in `--with-distribution-id` — and upstream
 * `toolkit/moz.configure` composes `CFBundleIdentifier` as
 * `<distribution-id>.<MOZ_MACBUNDLE_ID>`. Each half is unit-tested in its
 * own file; nothing pinned the COMPOSITION, which is the property that
 * actually broke (shipped: `org.hominis.org.hominis.browser`).
 *
 * This test recomposes the two halves the way upstream does and asserts
 * the result is the configured `appId` exactly — the one statement that
 * would have failed for the shipped defect.
 */
import { describe, expect, it } from 'vitest';

import { splitAppId } from '../branding.js';

/** Recomposes the bundle id the way `toolkit/moz.configure` does. */
function composeBundleId(appId: string): string {
  const { distributionId, leaf } = splitAppId(appId);
  return `${distributionId}.${leaf}`;
}

describe('composed macOS bundle identity', () => {
  it('round-trips every realistic appId back to itself', () => {
    for (const appId of [
      'org.hominis.browser',
      'org.example.mybrowser',
      'com.example.sub.browser',
      'io.acme.nightly',
    ]) {
      expect(composeBundleId(appId)).toBe(appId);
    }
  });

  it('never reproduces the doubled shape that shipped', () => {
    const appId = 'org.hominis.browser';
    expect(composeBundleId(appId)).not.toBe('org.hominis.org.hominis.browser');
    // The concrete regression: MOZ_MACBUNDLE_ID must be the LEAF only, so
    // the prefix cannot appear twice in the composition.
    expect(splitAppId(appId).leaf).toBe('browser');
    expect(splitAppId(appId).leaf).not.toContain('.');
  });

  it('keeps the halves disjoint — neither carries the other', () => {
    const { distributionId, leaf } = splitAppId('com.example.sub.browser');
    expect(distributionId).toBe('com.example.sub');
    expect(leaf).toBe('browser');
    expect(distributionId).not.toContain(leaf);
  });
});
