// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { matchesAnyGlob, matchesGlob } from './glob.js';

describe('matchesGlob', () => {
  it.each([
    ['*.toml', 'a.toml', true],
    ['*.toml', 'dir/a.toml', false],
    ['**/*.toml', 'a.toml', true],
    ['**/*.toml', 'x/y/a.toml', true],
    ['browser/**', 'browser/base/content/a.js', true],
    ['browser/**', 'browser', false],
    ['browser/**/a.js', 'browser/a.js', true],
    ['browser/**/a.js', 'browser/x/y/a.js', true],
    ['browser/*/a.js', 'browser/x/y/a.js', false],
    ['a?c.js', 'abc.js', true],
    ['a?c.js', 'a/c.js', false],
    ['a.b', 'axb', false],
    ['a+(b)', 'a+(b)', true],
    ['foo**bar', 'foo/x/bar', true],
  ])('%s against %s is %s', (glob, path, expected) => {
    expect(matchesGlob(path, glob)).toBe(expected);
  });

  it('matches a slash-less pattern against the file name when asked to', () => {
    expect(matchesGlob('browser/base/jar.mn', 'jar.mn', { basename: true })).toBe(true);
    expect(matchesGlob('browser/base/jar.mn', 'jar.mn')).toBe(false);
    expect(matchesGlob('browser/base/jar.mn', 'base/jar.mn', { basename: true })).toBe(false);
    expect(matchesGlob('browser/base/jar.mn', '**/base/jar.mn', { basename: true })).toBe(true);
  });
});

describe('matchesAnyGlob', () => {
  it('is true when any pattern matches and false for none', () => {
    expect(matchesAnyGlob('a/b.css', ['*.js', 'a/*.css'])).toBe(true);
    expect(matchesAnyGlob('a/b.css', [])).toBe(false);
  });
});
