// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the patch-body registration-reference scanner.
 *
 * `export-all --exclude-furnace` can produce a patch whose jar.mn /
 * customElements.js / locales jar.mn hunks add references to furnace
 * component files the patch does not itself carry, while `fireforge verify`
 * reports "Verify clean". The scanner extracts the component-shaped
 * references so verify can cross-check them against patch bodies and engine
 * files.
 *
 * The scan is narrow on purpose: only component-shaped references (widget
 * tag names, locale FTL names) match. Unrelated edits to the same files pass
 * through silently so the check never spurious-warns on ordinary patches.
 */

import { describe, expect, it } from 'vitest';

import { collectPatchRegistrationReferences } from '../patch-registration-refs.js';

describe('collectPatchRegistrationReferences', () => {
  it('extracts widget-tree targets from added jar.mn widget entries', () => {
    const body = [
      'diff --git a/toolkit/content/jar.mn b/toolkit/content/jar.mn',
      'index abc..def 100644',
      '--- a/toolkit/content/jar.mn',
      '+++ b/toolkit/content/jar.mn',
      '@@ -126,6 +126,8 @@ toolkit.jar:',
      '    content/global/elements/moz-label.mjs       (widgets/moz-label/moz-label.mjs)',
      '+   content/global/elements/moz-qa-panel.css  (widgets/moz-qa-panel/moz-qa-panel.css)',
      '+   content/global/elements/moz-qa-panel.mjs  (widgets/moz-qa-panel/moz-qa-panel.mjs)',
      '',
    ].join('\n');
    const refs = collectPatchRegistrationReferences(body);
    expect(refs.map((r) => r.targetPath).sort()).toEqual([
      'toolkit/content/widgets/moz-qa-panel/moz-qa-panel.css',
      'toolkit/content/widgets/moz-qa-panel/moz-qa-panel.mjs',
    ]);
    for (const ref of refs) {
      expect(ref.source).toBe('toolkit/content/jar.mn');
    }
  });

  it('extracts locale FTL targets from locales/jar.mn entries', () => {
    const body = [
      'diff --git a/toolkit/locales/jar.mn b/toolkit/locales/jar.mn',
      'index abc..def 100644',
      '--- a/toolkit/locales/jar.mn',
      '+++ b/toolkit/locales/jar.mn',
      '@@ -61,3 +61,5 @@',
      '   locale/@AB_CD@/autoconfig/autoconfig.properties   (%chrome/autoconfig/autoconfig.properties)',
      '+',
      '+  locale/@AB_CD@/toolkit/global/moz-qa-panel.ftl (%toolkit/global/moz-qa-panel.ftl)',
    ].join('\n');
    const refs = collectPatchRegistrationReferences(body);
    expect(refs.map((r) => r.targetPath)).toEqual([
      'toolkit/locales/en-US/toolkit/global/moz-qa-panel.ftl',
    ]);
  });

  it('extracts widget targets from customElements.js component table entries', () => {
    const body = [
      'diff --git a/toolkit/content/customElements.js b/toolkit/content/customElements.js',
      'index abc..def 100644',
      '--- a/toolkit/content/customElements.js',
      '+++ b/toolkit/content/customElements.js',
      '@@ -863,6 +863,7 @@',
      '           ["moz-option", "chrome://global/content/elements/moz-select.mjs"],',
      '+          ["moz-qa-panel", "chrome://global/content/elements/moz-qa-panel.mjs"],',
    ].join('\n');
    const refs = collectPatchRegistrationReferences(body);
    expect(refs).toEqual([
      expect.objectContaining({
        targetPath: 'toolkit/content/widgets/moz-qa-panel/moz-qa-panel.mjs',
        source: 'toolkit/content/customElements.js',
      }),
    ]);
  });

  it('ignores added lines in non-registration files', () => {
    const body = [
      'diff --git a/browser/base/content/browser.js b/browser/base/content/browser.js',
      '--- a/browser/base/content/browser.js',
      '+++ b/browser/base/content/browser.js',
      '@@ -1,3 +1,4 @@',
      '+// a normal added line with (widgets/moz-qa-panel/moz-qa-panel.mjs) inside',
    ].join('\n');
    expect(collectPatchRegistrationReferences(body)).toEqual([]);
  });

  it('ignores the +++ header line itself', () => {
    // The `+++ b/<path>` header starts with `+` but must not match. It
    // is diff metadata, not added content.
    const body = [
      'diff --git a/toolkit/content/jar.mn b/toolkit/content/jar.mn',
      '--- a/toolkit/content/jar.mn',
      '+++ b/toolkit/content/jar.mn',
      '@@ -1,3 +1,3 @@',
      ' unchanged',
    ].join('\n');
    expect(collectPatchRegistrationReferences(body)).toEqual([]);
  });

  it('returns an empty array for an empty patch body', () => {
    expect(collectPatchRegistrationReferences('')).toEqual([]);
  });

  it('ignores removed lines in registration files', () => {
    // Only `+` lines (additions) count. A `-` removal describes the
    // old state, which is not what we are verifying.
    const body = [
      'diff --git a/toolkit/content/jar.mn b/toolkit/content/jar.mn',
      '--- a/toolkit/content/jar.mn',
      '+++ b/toolkit/content/jar.mn',
      '@@ -1,3 +1,2 @@',
      '-   content/global/elements/moz-removed.mjs  (widgets/moz-removed/moz-removed.mjs)',
    ].join('\n');
    expect(collectPatchRegistrationReferences(body)).toEqual([]);
  });
});
