// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  jarIncMnEntryForChromeDoc,
  jarMnEntriesForChromeDoc,
  localeJarMnEntryForChromeDoc,
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
    // produced `obj-.../browser/themes/osx/shared/<name>-chrome.css` which
    // doesn't exist; `../shared/` climbs out of the theme-specific
    // directory and lands on the real `browser/themes/shared/` tree.
    expect(jarIncMnEntryForChromeDoc('fresh-lab')).toBe(
      '    content/browser/fresh-lab-chrome.css           (../shared/fresh-lab-chrome.css)'
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
