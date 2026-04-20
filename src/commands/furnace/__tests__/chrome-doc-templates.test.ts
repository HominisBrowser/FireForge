// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
} from '../chrome-doc-templates.js';

describe('chrome-doc jar.mn templates', () => {
  it('emits preprocessor-flagged xhtml + js entries under content/browser', () => {
    // The `*` flag enables brand-name substitution via the preprocessor;
    // the source column is resolved relative to `engine/browser/base/`.
    expect(jarMnEntriesForChromeDoc('fresh-lab')).toEqual([
      '*   content/browser/fresh-lab.xhtml                (content/fresh-lab.xhtml)',
      '    content/browser/fresh-lab.js                   (content/fresh-lab.js)',
    ]);
  });

  it('emits the scoped CSS under content/browser with the shared/ source path', () => {
    // The source column resolves relative to `engine/browser/themes/`
    // (the parent of the receiving jar.inc.mn), and the scaffold writes
    // the CSS to `engine/browser/themes/shared/<name>-chrome.css`.
    expect(jarIncMnEntryForChromeDoc('fresh-lab')).toBe(
      '    content/browser/fresh-lab-chrome.css           (shared/fresh-lab-chrome.css)'
    );
  });

  it('emits the locale FTL entry with a browser/ subdirectory source path (Finding #11)', () => {
    // Pre-0.16.0 the source column was `(%${name}.ftl)`, but the
    // scaffold writes the FTL at `engine/browser/locales/en-US/browser/<name>.ftl`.
    // `%` resolves relative to the per-locale root (e.g. `en-US/`), so
    // the `browser/` subdirectory MUST be part of the source path.
    // Without it, the first post-scaffold build fails with
    // "jar.mn: Cannot find <name>.ftl".
    expect(localeJarMnEntryForChromeDoc('fresh-lab')).toBe(
      '    locale/browser/fresh-lab.ftl                    (%browser/fresh-lab.ftl)'
    );
  });
});
