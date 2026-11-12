// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { type OwnedFiles, tokenSettings } from './settings.js';
import { siblingSheets } from './siblings.js';

function owned(files: Record<string, string>): OwnedFiles {
  return { paths: Object.keys(files), read: (path) => Promise.resolve(files[path]) };
}

const plain = (siblings: Map<string, Set<string>>): Record<string, string[]> =>
  Object.fromEntries([...siblings].map(([sheet, set]) => [sheet, [...set].sort()]));

describe('siblingSheets', () => {
  it('pairs the sheets one document links, through jar.mn and relative URLs', async () => {
    const files = owned({
      'browser/base/jar.mn':
        'browser.jar:\n  content/browser/a.css  (content/a.css)\n  skin/classic/browser/b.css  (content/b.css)\n',
      'browser/base/content/doc.xhtml': [
        '<?xml-stylesheet href="chrome://browser/content/a.css"?>',
        '<html:link rel="stylesheet" href="chrome://browser/skin/b.css"/>',
        '<link rel="stylesheet" href="c.css">',
        '<link rel="icon" href="d.css">',
      ].join('\n'),
      'browser/base/content/a.css': '',
      'browser/base/content/b.css': '',
      'browser/base/content/c.css': '',
      'browser/base/content/d.css': '',
    });
    const sheets = ['a', 'b', 'c', 'd'].map((name) => `browser/base/content/${name}.css`);
    expect(plain(await siblingSheets(files, sheets, tokenSettings(undefined, 'acme')))).toEqual({
      'browser/base/content/a.css': ['browser/base/content/b.css', 'browser/base/content/c.css'],
      'browser/base/content/b.css': ['browser/base/content/a.css', 'browser/base/content/c.css'],
      'browser/base/content/c.css': ['browser/base/content/a.css', 'browser/base/content/b.css'],
    });
  });

  it('pairs a sheet with what it imports, and adds configured pairings by glob', async () => {
    const files = owned({
      'x/main.css': '@import url("parts/one.css");\n',
      'x/parts/one.css': '',
      'y/panel.css': '',
      'y/base.css': '',
    });
    const settings = tokenSettings({ tokenSiblingSheets: { 'y/p*.css': ['y/base.css'] } }, 'acme');
    const sheets = ['x/main.css', 'x/parts/one.css', 'y/panel.css', 'y/base.css'];
    expect(plain(await siblingSheets(files, sheets, settings))).toEqual({
      'x/main.css': ['x/parts/one.css'],
      'x/parts/one.css': ['x/main.css'],
      'y/panel.css': ['y/base.css'],
    });
  });
});
