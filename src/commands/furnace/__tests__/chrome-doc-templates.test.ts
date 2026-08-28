// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
  localesFtlWildcardCapturesScaffoldedName,
} from '../chrome-doc-templates.js';

describe('chrome-doc jar.mn templates', () => {
  it('emits xhtml + js entries under content/browser without preprocessor flags', () => {
    // Neither entry is `*`-flagged. The scaffolded XHTML and JS contain no
    // `#filter`/`#expand`/`#include` directives, so marking them as
    // preprocessed fails the install-manifest step with "no preprocessor
    // directives found". Forks that later add brand substitution can
    // re-introduce `*` alongside a top-of-file `#filter substitution`.
    expect(jarMnEntriesForChromeDoc('fresh-lab')).toEqual([
      '    content/browser/fresh-lab.xhtml                (content/fresh-lab.xhtml)',
      '    content/browser/fresh-lab.js                   (content/fresh-lab.js)',
    ]);
  });

  it('emits the scoped CSS with the `../shared/` source path', () => {
    // `jar.inc.mn` is included from each theme-specific manifest
    // (`browser/themes/osx/jar.mn`, `…/linux/jar.mn`, `…/windows/jar.mn`)
    // where every existing entry resolves paths relative to the including
    // manifest's directory. A bare `(shared/<name>-chrome.css)` source
    // resolves to `obj-.../browser/themes/osx/shared/<name>-chrome.css`,
    // which does not exist; `../shared/` climbs out of the theme-specific
    // directory and lands on the real `browser/themes/shared/` tree.
    expect(jarIncMnEntryForChromeDoc('fresh-lab')).toBe(
      '    content/browser/fresh-lab-chrome.css           (../shared/fresh-lab-chrome.css)'
    );
  });

  it('detects [localization] wildcards rooted at %browser/ that would capture the scaffolded FTL', () => {
    // Recursive shape (the upstream pattern).
    expect(
      localesFtlWildcardCapturesScaffoldedName(
        '[localization] @AB_CD@.jar:\n  browser (%browser/**/*.ftl)\n'
      )
    ).toBe(true);
    // Flat shape — also captures top-level browser/<name>.ftl.
    expect(
      localesFtlWildcardCapturesScaffoldedName(
        '[localization] @AB_CD@.jar:\n  browser (%browser/*.ftl)\n'
      )
    ).toBe(true);
  });

  it('does not treat narrower wildcards as a capture of browser/<name>.ftl', () => {
    // A subdirectory-scoped wildcard like browser/about/*.ftl would NOT
    // pick up a top-level browser/<name>.ftl, so the per-file entry must
    // still be written.
    expect(
      localesFtlWildcardCapturesScaffoldedName(
        '[localization] @AB_CD@.jar:\n  browser (%browser/about/*.ftl)\n'
      )
    ).toBe(false);
    // An explicit per-file reference (no `*`) is not a wildcard.
    expect(
      localesFtlWildcardCapturesScaffoldedName('  locale/browser/foo.ftl (%browser/foo.ftl)\n')
    ).toBe(false);
    // Empty file — nothing to capture.
    expect(localesFtlWildcardCapturesScaffoldedName('')).toBe(false);
  });

  it('emits the locale FTL entry with a browser/ subdirectory source path', () => {
    // A source column of `(%${name}.ftl)` points at `en-US/<name>.ftl`, but
    // the scaffold writes the FTL at
    // `engine/browser/locales/en-US/browser/<name>.ftl`. `%` resolves
    // relative to the per-locale root, so the `browser/` subdirectory MUST
    // be part of the source path — without it the first post-scaffold build
    // fails with "jar.mn: Cannot find <name>.ftl".
    expect(localeJarMnEntryForChromeDoc('fresh-lab')).toBe(
      '    locale/browser/fresh-lab.ftl                    (%browser/fresh-lab.ftl)'
    );
  });
});
