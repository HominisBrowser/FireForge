// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { jarHasEntry, mozBuildListContains, scopedJarTokens } from '../moz-manifest-entries.js';
import { insertJarMnEntry, insertMozBuildListEntry } from '../moz-manifest-helpers.js';

const entry = '  content/browser/new.js (content/new.js)';
const options = {
  sortPattern: /^content\/browser\/(.+)$/,
  sortKey: 'new.js',
  missingSectionMessage: 'missing',
};

describe('packaging scope preservation', () => {
  it('inserts outside nested preprocessor regions while preserving their bytes', () => {
    const conditional =
      '#ifdef WIN\n#ifdef DEBUG\n  content/browser/z.js (content/z.js)\n#endif\n#endif';
    const content = `browser.jar:\n  content/browser/a.js (content/a.js)\n${conditional}\n`;
    const { result } = insertJarMnEntry(content, entry, options);
    expect(result).toContain(conditional);
    expect(result.indexOf(entry)).toBeLessThan(result.indexOf('#ifdef WIN'));
  });
  it('uses an unconditional archive header when all neighboring entries are conditional', () => {
    const { result } = insertJarMnEntry(
      'browser.jar:\n#ifdef WIN\n  content/browser/z.js (content/z.js)\n#else\n  content/browser/a.js (content/a.js)\n#endif\n',
      entry,
      options
    );
    expect(result).toContain(`browser.jar:\n${entry}\n#ifdef`);
  });
  it('refuses a conditional after-anchor rather than changing the new file platform scope', () => {
    expect(() =>
      insertJarMnEntry(
        'browser.jar:\n#ifdef WIN\n  content/browser/z.js (content/z.js)\n#endif',
        entry,
        { ...options, after: 'z.js' }
      )
    ).toThrow(/conditional/);
  });
  it('refuses ambiguity between archives instead of globally sorting their entries', () => {
    expect(() =>
      insertJarMnEntry(
        'a.jar:\n  content/browser/a.js (content/a.js)\nb.jar:\n  content/browser/z.js (content/z.js)',
        entry,
        options
      )
    ).toThrow(/Ambiguous/);
  });
  it.each(['#endif', '#else', '#elif DEBUG', '#ifdef DEBUG'])(
    'refuses malformed preprocessor scope: %s',
    (text) => {
      expect(() => scopedJarTokens(text)).toThrow(/Unbalanced/);
    }
  );
  it('refuses a destination collision with a different source', () => {
    expect(() =>
      insertJarMnEntry('browser.jar:\n  content/browser/new.js (content/other.js)', entry, options)
    ).toThrow(/different source/);
  });
  it('matches exact packaging destinations and sources, ignoring comments and longer names', () => {
    const targets = ['skin/classic/browser/nested/file.css'];
    const source = '../shared/nested/file.css';
    expect(
      jarHasEntry(
        `# skin/classic/browser/nested/file.css (${source})\n  skin/classic/browser/nested/file.css.extra (${source})`,
        targets,
        source
      )
    ).toBe(false);
    expect(jarHasEntry(`  ${targets[0]} (../shared/other.css)`, targets, source)).toBe(false);
    expect(jarHasEntry(`  ${targets[0]} (${source})`, targets, source)).toBe(true);
  });
  it('matches only active values in the requested list, with either quote style', () => {
    const content =
      '# EXTRA_JS_MODULES += [\n# "File.sys.mjs",\n# ]\nOTHER += [\n "File.sys.mjs",\n]\nEXTRA_JS_MODULES += [\n "File.sys.mjs.extra",\n \'Real.sys.mjs\',\n]\n';
    expect(mozBuildListContains(content, 'EXTRA_JS_MODULES', 'File.sys.mjs')).toBe(false);
    expect(mozBuildListContains(content, 'EXTRA_JS_MODULES', 'Real.sys.mjs')).toBe(true);
    expect(
      mozBuildListContains(
        'if CONFIG["WIN"]:\n    EXTRA_JS_MODULES += [\n        "Real.sys.mjs",\n    ]',
        'EXTRA_JS_MODULES',
        'Real.sys.mjs'
      )
    ).toBe(false);
  });
  it('recognizes a real entry in a later or inline list without accepting another list identity', () => {
    const css =
      'OTHER += ["Owned.sys.mjs"]\nEXTRA_JS_MODULES += []\nEXTRA_JS_MODULES += ["Real.sys.mjs"] # retained\n';
    expect(mozBuildListContains(css, 'EXTRA_JS_MODULES', 'Real.sys.mjs')).toBe(true);
    expect(mozBuildListContains(css, 'EXTRA_JS_MODULES', 'Owned.sys.mjs')).toBe(false);
    expect(() =>
      insertMozBuildListEntry(css, '    "New.sys.mjs",', {
        listPattern: /^EXTRA_JS_MODULES\b/,
        sortKey: 'New.sys.mjs',
        missingListMessage: 'missing',
      })
    ).toThrow(/Ambiguous/);
  });
  it('recognizes the preprocessed jar entry flag as packaging metadata', () => {
    expect(
      jarHasEntry(
        '* content/browser/new.xhtml (content/new.xhtml)',
        ['content/browser/new.xhtml'],
        'content/new.xhtml'
      )
    ).toBe(true);
  });
});
