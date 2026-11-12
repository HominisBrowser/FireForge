// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import type { JarEntry } from './jar.js';
import {
  findJarEntries,
  insertJarEntry,
  jarReferences,
  parseJar,
  updateJarEntries,
} from './jar.js';

/** Removes the entries `where` selects. */
const drop = (
  text: string,
  where: (entry: JarEntry) => boolean
): ReturnType<typeof updateJarEntries> =>
  updateJarEntries(text, (entry) => (where(entry) ? null : undefined));

const lines = (...rows: string[]): string => rows.join('\n') + '\n';

describe('parseJar line classification', () => {
  const CASES: [string, string, string][] = [
    ['a header', 'browser.jar:', 'header'],
    ['a localization header', '[localization] @AB_CD@.jar:', 'header'],
    ['a chrome manifest line', '% content global %content/global/', 'chrome-manifest'],
    ['an indented entry', '   content/global/a.js  (widgets/a.js)', 'entry'],
    ['a tab-indented entry', '\tcontent/global/a.js  (widgets/a.js)', 'entry'],
    ['a flagged entry', '*  content/a.xhtml  (a.xhtml)', 'entry'],
    ['an entry with no source', '   content/branding/about.png', 'entry'],
    ['an entry with nested parentheses', '  content/a.js  (widgets/a(1).js)', 'entry'],
    ['an entry with a trailing comment', '  content/a.js  (a.js) # note', 'entry'],
    ['a truncated entry', '   content/global/a.js  (widgets/a.js', 'unknown'],
    ['a comment', '# top comment', 'comment'],
    ['a double-hash comment', '## double', 'comment'],
    ['a prose comment that starts with "if"', '# if you add a file, sort it', 'comment'],
    ['an #ifdef', '#ifdef XP_WIN', 'preprocessor'],
    ['an #include', '#include foo.inc', 'preprocessor'],
    ['a #filter', '#filter substitution', 'preprocessor'],
    ['a blank line', '', 'blank'],
    ['a whitespace line', ' \t ', 'blank'],
  ];

  it.each(CASES)('classifies %s', (_label, line, kind) => {
    expect(parseJar(`${line}\n`).kinds[0]).toBe(kind);
  });

  it('reads the fields of an entry', () => {
    const [entry] = parseJar(
      'browser.jar:\n*   content/browser/a.xhtml    (content/a.xhtml)\n'
    ).entries;
    expect(entry).toMatchObject({
      line: 1,
      indent: '',
      flags: '*',
      target: 'content/browser/a.xhtml',
      source: 'content/a.xhtml',
      localized: false,
      jar: 'browser.jar',
      section: 1,
      conditional: false,
    });
    expect(entry?.text.charAt(entry.sourceColumn ?? 0)).toBe('(');
  });

  it('reads nested parentheses, localized sources and sourceless entries', () => {
    const entries = parseJar(
      lines(
        '@AB_CD@.jar:',
        '  locale/a.ftl  (%toolkit/a.ftl)',
        '  content/a.js  (widgets/a(1).js)',
        '  content/b.png'
      )
    ).entries;
    expect(entries.map((e) => [e.target, e.source, e.localized])).toEqual([
      ['locale/a.ftl', 'toolkit/a.ftl', true],
      ['content/a.js', 'widgets/a(1).js', false],
      ['content/b.png', undefined, false],
    ]);
  });

  it('keeps the jar and section of each entry across several jars', () => {
    const entries = parseJar(
      lines('a.jar:', '  x/1 (1)', '', '[localization] b.jar:', '  x/2 (2)')
    ).entries;
    expect(entries.map((e) => [e.jar, e.section])).toEqual([
      ['a.jar', 1],
      ['b.jar', 2],
    ]);
  });

  it('reads a jar prefix written on the entry line', () => {
    const [entry] = parseJar('en-US.jar:   content/foo.js  (content/foo.js)\n').entries;
    expect(entry).toMatchObject({
      jar: 'en-US.jar',
      target: 'content/foo.js',
      source: 'content/foo.js',
    });
  });

  it('marks entries inside conditionals, nested or with #else', () => {
    const manifest = parseJar(
      lines('a.jar:', '#ifdef X', '  x/1 (1)', '#else', '  x/2 (2)', '#endif', '  x/3 (3)')
    );
    expect(manifest.entries.map((e) => e.conditional)).toEqual([true, true, false]);
    expect(manifest.balanced).toBe(true);
  });

  it.each(['#endif', '#else', '#elif DEBUG', '#ifdef DEBUG'])('flags unbalanced %s', (text) => {
    expect(parseJar(text).balanced).toBe(false);
  });

  it('reads the words of a chrome manifest line', () => {
    expect(
      parseJar('%  content browser %content/browser/ contentaccessible=yes').chromeManifests[0]
        ?.args
    ).toEqual(['content', 'browser', '%content/browser/', 'contentaccessible=yes']);
  });
});

describe('findJarEntries', () => {
  it('matches exact targets and sources, ignoring comments and longer names', () => {
    const source = '../shared/nested/file.css';
    const target = 'skin/classic/browser/nested/file.css';
    const text = lines(
      `# ${target} (${source})`,
      `  ${target}.extra (${source})`,
      `  ${target} (../shared/other.css)`
    );
    expect(findJarEntries(text, { target: [target], source })).toEqual([]);
    expect(
      findJarEntries(`${text}  ${target} (${source})\n`, { target: [target], source })
    ).toHaveLength(1);
  });

  it('accepts any of several targets, and the preprocess flag', () => {
    const text = '* content/browser/new.xhtml (content/new.xhtml)\n';
    expect(
      findJarEntries(text, {
        target: ['x', 'content/browser/new.xhtml'],
        source: 'content/new.xhtml',
      })
    ).toHaveLength(1);
  });
});

describe('insertJarEntry', () => {
  const widgets = lines(
    'toolkit.jar:',
    '% content global %content/global/',
    '   content/global/elements/findbar.js  (widgets/findbar/findbar.js)',
    '   content/global/elements/wizard.js  (widgets/wizard/wizard.js)'
  );
  const tagKey = (target: string): string => target.split('/').pop()?.split('.')[0] ?? target;

  it('keeps the indentation of a neighbour that carries a flag', () => {
    const flagged = lines(
      'browser.jar:',
      '*       content/browser/a.xhtml  (content/a.xhtml)',
      '        content/browser/c.js     (content/c.js)'
    );
    const { text } = insertJarEntry(flagged, {
      target: 'content/browser/b.js',
      source: 'content/b.js',
    });
    expect(text.split('\n')[2]).toBe('        content/browser/b.js     (content/b.js)');
  });

  it('inserts in sort order, keeping a batch of one tag together', () => {
    let text = widgets;
    for (const file of ['search-textbox.mjs', 'search-textbox.css']) {
      text = insertJarEntry(
        text,
        { target: `content/global/elements/${file}`, source: `widgets/search-textbox/${file}` },
        { sortKey: tagKey }
      ).text;
    }
    const rows = text.split('\n');
    const at = (needle: string): number => rows.findIndex((row) => row.includes(needle));
    expect(at('findbar.js')).toBeLessThan(at('search-textbox.mjs'));
    expect(at('search-textbox.css')).toBeLessThan(at('wizard.js'));
  });

  it('copies indentation and the source column of its neighbour', () => {
    const placed = insertJarEntry(widgets, {
      target: 'content/global/elements/moz-card.mjs',
      source: 'widgets/moz-card/moz-card.mjs',
    });
    expect(placed.line).toBe(3);
    expect(placed.previous).toBe(
      'content/global/elements/findbar.js  (widgets/findbar/findbar.js)'
    );
    expect(placed.text.split('\n')[3]).toBe(
      '   content/global/elements/moz-card.mjs  (widgets/moz-card/moz-card.mjs)'
    );
  });

  it('aligns the source column with neighbours when the target fits', () => {
    const text = lines(
      'a.jar:',
      '  skin/a.css                      (../shared/a.css)',
      '  skin/c.css                      (../shared/c.css)'
    );
    const placed = insertJarEntry(text, { target: 'skin/b.css', source: '../shared/b.css' });
    expect(placed.text.split('\n')[2]).toBe('  skin/b.css                      (../shared/b.css)');
  });

  it('keeps a gap when the target outgrows the column', () => {
    const text = lines('a.jar:', '  skin/a.css   (../shared/a.css)');
    const placed = insertJarEntry(text, {
      target: 'skin/a-very-long-name-indeed.css',
      source: '../shared/x.css',
    });
    expect(placed.text).toContain('  skin/a-very-long-name-indeed.css  (../shared/x.css)');
  });

  it('writes flags in the indent column and a localized source with %', () => {
    const text = lines('a.jar:', '        content/browser/a.js    (content/a.js)');
    const placed = insertJarEntry(text, {
      target: 'content/browser/b.xhtml',
      source: 'content/b.xhtml',
      flags: '*',
    });
    expect(placed.text.split('\n')[2]).toMatch(
      /^\* {7}content\/browser\/b\.xhtml {2}\(content\/b\.xhtml\)$/
    );
    const locale = insertJarEntry(lines('@AB_CD@.jar:', '  locale/a.ftl (%a.ftl)'), {
      target: 'locale/b.ftl',
      source: 'b.ftl',
      localized: true,
    });
    expect(locale.text).toContain('(%b.ftl)');
  });

  it('appends after the group when it is not sorted', () => {
    const text = lines('a.jar:', '  x/z.js (z.js)', '  x/a.js (a.js)', '', '  y/q.js (q.js)');
    const placed = insertJarEntry(text, { target: 'x/m.js', source: 'm.js' });
    expect(placed.text.split('\n').slice(1, 4)).toEqual([
      '  x/z.js (z.js)',
      '  x/a.js (a.js)',
      '  x/m.js  (m.js)',
    ]);
  });

  it('inserts case-insensitively when the group is sorted that way', () => {
    const text = lines('a.jar:', '  x/Alpha.js (a)', '  x/beta.js (b)');
    expect(insertJarEntry(text, { target: 'x/Charlie.js', source: 'c' }).line).toBe(3);
    expect(insertJarEntry(text, { target: 'x/alpine.js', source: 'c' }).line).toBe(2);
  });

  it('falls back to the nearest ancestor directory with entries', () => {
    const text = lines(
      'toolkit.jar:',
      '% content global %content/global/',
      '   content/global/aaa.js (aaa.js)',
      '',
      '   other/bar.js (bar.js)'
    );
    const placed = insertJarEntry(text, { target: 'content/global/elements/x.js', source: 'x.js' });
    expect(placed.line).toBe(3);
  });

  it('starts an empty jar after its header and chrome manifest lines', () => {
    const placed = insertJarEntry(lines('# c', 'a.jar:', '% content a %a/'), {
      target: 'a/x',
      source: 'x',
    });
    expect(placed.line).toBe(3);
  });

  it('inserts outside nested conditionals and leaves their bytes alone', () => {
    const conditional =
      '#ifdef WIN\n#ifdef DEBUG\n  content/browser/z.js (content/z.js)\n#endif\n#endif';
    const text = `browser.jar:\n  content/browser/a.js (content/a.js)\n${conditional}\n`;
    const { text: result } = insertJarEntry(text, {
      target: 'content/browser/new.js',
      source: 'content/new.js',
    });
    expect(result).toContain(conditional);
    expect(result.indexOf('new.js')).toBeLessThan(result.indexOf('#ifdef WIN'));
  });

  it('uses the header when every neighbour is conditional', () => {
    const text =
      'browser.jar:\n#ifdef WIN\n  content/browser/z.js (z)\n#else\n  content/browser/a.js (a)\n#endif\n';
    const { text: result } = insertJarEntry(text, {
      target: 'content/browser/new.js',
      source: 'n',
    });
    expect(result).toBe(
      'browser.jar:\n    content/browser/new.js  (n)\n#ifdef WIN\n  content/browser/z.js (z)\n#else\n  content/browser/a.js (a)\n#endif\n'
    );
  });

  it('is a no-op for an existing entry and refuses a different source', () => {
    const text = lines('a.jar:', '  x/a.js (a.js)');
    const same = insertJarEntry(text, { target: 'x/a.js', source: 'a.js' });
    expect(same).toEqual({ text, changed: false, line: 1 });
    expect(() => insertJarEntry(text, { target: 'x/a.js', source: 'other.js' })).toThrow(
      /different source/
    );
  });

  it('refuses an unbalanced conditional and an ambiguous jar', () => {
    expect(() => insertJarEntry('a.jar:\n#endif\n', { target: 'x/a', source: 'a' })).toThrow(
      /unbalanced/
    );
    const two = lines('a.jar:', '  content/a.js (a)', 'b.jar:', '  content/z.js (z)');
    expect(() => insertJarEntry(two, { target: 'content/m.js', source: 'm' })).toThrow(
      /several jar sections/
    );
    expect(
      insertJarEntry(two, { target: 'content/m.js', source: 'm' }, { jar: 'b.jar' }).line
    ).toBe(3);
  });

  it('names a section by its header as written, base included', () => {
    const locale = lines(
      '[localization] @AB_CD@.jar:',
      '  branding (%*.ftl)',
      '',
      '@AB_CD@.jar:',
      '% locale branding @AB_CD@ %locale/branding/',
      '  locale/branding/brand.properties (%brand.properties)'
    );
    expect(
      insertJarEntry(locale, { target: 'zz/new.js', source: 'new.js' }, { jar: '@AB_CD@.jar' }).line
    ).toBe(5);
    expect(
      insertJarEntry(
        locale,
        { target: 'zz', source: '*.ftl', localized: true },
        { jar: '[localization] @AB_CD@.jar' }
      ).line
    ).toBe(2);
    const twice = lines('a.jar:', '  x/a.js (a)', 'a.jar:', '  y/b.js (b)');
    expect(() =>
      insertJarEntry(twice, { target: 'z/m.js', source: 'm' }, { jar: 'a.jar' })
    ).toThrow(/several a\.jar sections/);
  });

  it('refuses a jar that does not exist', () => {
    expect(() =>
      insertJarEntry('a.jar:\n', { target: 'x', source: 'y' }, { jar: 'nope.jar' })
    ).toThrow(/nope\.jar/);
  });

  describe('after', () => {
    const text = lines('a.jar:', '  x/a.js (a.js)', '  x/c.js (c.js)');
    it('places the entry right after the named one', () => {
      const placed = insertJarEntry(text, { target: 'x/z.js', source: 'z' }, { after: 'a.js' });
      expect(placed.line).toBe(2);
      expect(placed.previous).toBe('x/a.js (a.js)');
    });
    it('falls back to sort order and says so', () => {
      const placed = insertJarEntry(
        text,
        { target: 'x/b.js', source: 'b' },
        { after: 'missing.js' }
      );
      expect(placed.line).toBe(2);
      expect(placed.afterFallback).toBe(true);
    });
    it('refuses an anchor inside a conditional', () => {
      const conditional = 'a.jar:\n#ifdef WIN\n  x/z.js (z.js)\n#endif\n';
      expect(() =>
        insertJarEntry(conditional, { target: 'x/n.js', source: 'n' }, { after: 'z.js' })
      ).toThrow(/conditional/);
    });
  });

  it('keeps a comment attached to the entry below it', () => {
    const text = lines('a.jar:', '  x/a.js (a)', '# explains c', '  x/c.js (c)');
    expect(insertJarEntry(text, { target: 'x/b.js', source: 'b' }).line).toBe(2);
  });

  it('preserves CRLF endings and a missing final newline', () => {
    const crlf = 'a.jar:\r\n  x/a.js (a)\r\n  x/c.js (c)';
    const { text } = insertJarEntry(crlf, { target: 'x/b.js', source: 'b' });
    expect(text).toBe('a.jar:\r\n  x/a.js (a)\r\n  x/b.js  (b)\r\n  x/c.js (c)');
    expect(insertJarEntry(crlf, { target: 'x/d.js', source: 'd' }).text.endsWith('(d)')).toBe(true);
  });
});

describe('updateJarEntries', () => {
  const text = lines(
    'toolkit.jar:',
    '   content/global/elements/moz-card.mjs      (widgets/moz-card/moz-card.mjs)',
    '   content/global/elements/moz-card.css  (widgets/moz-card/moz-card.css) # keep',
    '   content/global/elements/moz-card-group.mjs  (widgets/moz-card-group/moz-card-group.mjs)',
    '# widgets/moz-card/ (not an entry)'
  );

  it('removes only the selected lines', () => {
    const result = drop(text, (entry) => entry.source?.startsWith('widgets/moz-card/') === true);
    expect(result.removed).toHaveLength(2);
    expect(result.text).toBe(
      lines(
        'toolkit.jar:',
        '   content/global/elements/moz-card-group.mjs  (widgets/moz-card-group/moz-card-group.mjs)',
        '# widgets/moz-card/ (not an entry)'
      )
    );
  });

  it('retargets in place, keeping indent, spacing and trailing comments', () => {
    const result = updateJarEntries(text, (entry) =>
      entry.source?.startsWith('widgets/moz-card/') === true
        ? {
            target: entry.target.replace('moz-card', 'moz-tile'),
            source: entry.source.replace(/moz-card/g, 'moz-tile'),
          }
        : undefined
    );
    expect(result.updated).toHaveLength(2);
    expect(result.text.split('\n').slice(1, 3)).toEqual([
      '   content/global/elements/moz-tile.mjs      (widgets/moz-tile/moz-tile.mjs)',
      '   content/global/elements/moz-tile.css  (widgets/moz-tile/moz-tile.css) # keep',
    ]);
  });

  it('drops and rewrites in one pass', () => {
    const result = updateJarEntries(text, (entry) =>
      entry.target.endsWith('.css')
        ? null
        : entry.target.endsWith('group.mjs')
          ? { target: 'x/g.mjs' }
          : undefined
    );
    expect(result.removed.map((e) => e.target)).toEqual(['content/global/elements/moz-card.css']);
    expect(result.text).toContain('x/g.mjs  (widgets/moz-card-group/moz-card-group.mjs)');
  });

  it('returns the text untouched when nothing matches', () => {
    const result = drop(text, () => false);
    expect(result).toEqual({ text, changed: false, removed: [], updated: [] });
  });

  it('keeps an unterminated last line unterminated', () => {
    expect(drop('a.jar:\n  x/a (a)\n  x/b (b)', (e) => e.target === 'x/b').text).toBe(
      'a.jar:\n  x/a (a)'
    );
  });
});

describe('jarReferences', () => {
  it('resolves sources against the manifest directory and skips locale and substituted sources', () => {
    const refs = jarReferences(
      'browser/base/jar.mn',
      lines(
        'browser.jar:',
        '  content/browser/a.js  (content/a.js)',
        '  content/browser/b.md  (../app/b.md)',
        '  content/browser/c.js  (content/*.js)',
        '  locale/a.ftl  (%a.ftl)',
        '  content/@AB_CD@/d  (@AB_CD@/d)',
        '  content/e  (../../../../outside)'
      )
    );
    expect(refs.map((ref) => [ref.token, ref.matcher.exact])).toEqual([
      ['content/a.js', 'browser/base/content/a.js'],
      ['../app/b.md', 'browser/app/b.md'],
      ['content/*.js', undefined],
    ]);
    expect(refs[2]?.matcher.matches('browser/base/content/z.js')).toBe(true);
    expect(refs[0]?.line).toBe(1);
  });

  it('reads an entry without a source as the target file name beside the manifest', () => {
    const refs = jarReferences(
      'toolkit/content/jar.mn',
      lines(
        'toolkit.jar:',
        '   content/global/aboutSupport.xhtml',
        '*  content/global/license.html'
      )
    );
    expect(refs.map((ref) => [ref.token, ref.matcher.exact])).toEqual([
      ['aboutSupport.xhtml', 'toolkit/content/aboutSupport.xhtml'],
      ['license.html', 'toolkit/content/license.html'],
    ]);
  });

  it('lists only the root-relative sources of an included manifest', () => {
    const refs = jarReferences(
      'toolkit/themes/shared/desktop-jar.inc.mn',
      lines('  skin/classic/global/a.css  (../../shared/a.css)', '  skin/b.css  (/toolkit/b.css)')
    );
    expect(refs.map((ref) => ref.matcher.exact)).toEqual(['toolkit/b.css']);
  });
});
