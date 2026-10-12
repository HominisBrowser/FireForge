// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { globToRegExp, matchesAnyGlob } from '../path-glob.js';

describe('path globs', () => {
  it.each([
    ['browser/base/content/browser.js', 'browser/base/content/browser.js', true],
    ['browser/*/browser.js', 'browser/base/browser.js', true],
    ['browser/*/browser.js', 'browser/base/content/browser.js', false],
    ['**/moz.build', 'moz.build', true],
    ['**/moz.build', 'browser/components/moz.build', true],
    ['**/moz.build', 'browser/components/moz.buildx', false],
    ['browser/**', 'browser/a/b/c.js', true],
    ['browser/**/test/**', 'browser/base/content/test/hominis/browser_a.js', true],
    ['**/test/**', 'browser/test.js', false],
    ['*.toml', 'browser.toml', true],
    ['*.toml', 'a/browser.toml', false],
    ['jar?.mn', 'jar1.mn', true],
    ['jar?.mn', 'jar/.mn', false],
    ['a.b', 'axb', false],
    ['a**b', 'a/x/b', true],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('matchesAnyGlob is true when one glob matches', () => {
    expect(matchesAnyGlob('x/y.css', ['a/**', 'x/*.css'])).toBe(true);
    expect(matchesAnyGlob('x/y.css', [])).toBe(false);
  });
});
