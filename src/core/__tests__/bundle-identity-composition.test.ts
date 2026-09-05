// SPDX-License-Identifier: EUPL-1.2
/**
 * The doubled macOS bundle id must be closed for good.
 *
 * The two halves of the identity are written by two different modules:
 * `branding.ts` puts the leaf in `MOZ_MACBUNDLE_ID` and `mach-mozconfig.ts`
 * puts the prefix in `--with-distribution-id`. Upstream
 * `toolkit/moz.configure` then composes `CFBundleIdentifier` as
 * `<distribution-id>.<MOZ_MACBUNDLE_ID>`. Each half is unit-tested in its
 * own file. Nothing pins the composition, which is the property that
 * actually breaks.
 *
 * This test recomposes the two halves the way upstream does and asserts the
 * result is the configured `appId` exactly.
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
    // The concrete regression: MOZ_MACBUNDLE_ID must be the leaf only, so
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
