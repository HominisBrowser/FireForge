// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  buildSiblingSheetMap,
  collectStylesheetUrls,
  resolveStylesheetUrl,
} from '../token-sibling-sheets.js';

describe('collectStylesheetUrls', () => {
  it('reads stylesheet links and processing instructions, not other links', () => {
    const markup = [
      '<?xml-stylesheet href="chrome://browser/skin/a.css" type="text/css"?>',
      '<link rel="stylesheet" href="chrome://global/content/elements/moz-x.css" />',
      '<html:link href="b.css" rel="stylesheet"/>',
      '<link rel="localization" href="browser/x.ftl"/>',
      '<link rel="stylesheet" href="${dynamic}.css"/>',
    ].join('\n');
    expect(collectStylesheetUrls('browser/doc.xhtml', markup)).toEqual([
      'chrome://global/content/elements/moz-x.css',
      'b.css',
      'chrome://browser/skin/a.css',
    ]);
  });

  it('reads @import in a sheet', () => {
    expect(
      collectStylesheetUrls(
        'a.css',
        '@import url("chrome://browser/skin/t.css");\n@import "b.css";'
      )
    ).toEqual(['chrome://browser/skin/t.css', 'b.css']);
  });
});

describe('resolveStylesheetUrl', () => {
  const jar = new Map([
    ['content/global/elements/moz-x.css', 'toolkit/content/widgets/moz-x/moz-x.css'],
    ['skin/classic/browser/t.css', 'browser/themes/shared/t.css'],
  ]);
  const known = new Set(['browser/base/b.css']);

  it.each([
    ['chrome://global/content/elements/moz-x.css', 'toolkit/content/widgets/moz-x/moz-x.css'],
    ['chrome://browser/skin/t.css', 'browser/themes/shared/t.css'],
    ['chrome://browser/skin/unknown.css', undefined],
    ['b.css', 'browser/base/b.css'],
    ['other.css', undefined],
    ['https://example.com/x.css', undefined],
  ])('%s → %s', (url, expected) => {
    expect(resolveStylesheetUrl(url, 'browser/base/doc.xhtml', jar, known)).toBe(expected);
  });
});

describe('buildSiblingSheetMap', () => {
  it('pairs sheets one document links, an importer with its import, and explicit partners', () => {
    const map = buildSiblingSheetMap({
      documents: [
        ['d/doc.html', '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="b.css">'],
        ['d/c.css', '@import "e.css";'],
      ],
      jarTargets: new Map(),
      sheets: ['d/a.css', 'd/b.css', 'd/c.css', 'd/e.css', 'v/one.css', 'v/two.css'],
      explicit: { 'v/*.css': ['v/*.css', 'up/host.css'] },
    });
    expect([...(map.get('d/a.css') ?? [])]).toEqual(['d/b.css']);
    expect([...(map.get('d/e.css') ?? [])]).toEqual(['d/c.css']);
    expect([...(map.get('v/one.css') ?? [])]).toEqual(['v/two.css', 'up/host.css']);
  });
});
