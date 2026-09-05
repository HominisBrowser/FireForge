// SPDX-License-Identifier: EUPL-1.2
/**
 * Unit tests for the dark-mode insertion helpers in
 * `src/core/token-dark-mode.ts`. `token add --mode override` must land the
 * dark declaration between the nested `:root {` and its matching `}` inside
 * the `@media (prefers-color-scheme: dark)` block, not between that `}` and
 * the outer `@media` close, which puts the declaration outside any rule.
 */
import { describe, expect, it } from 'vitest';

import {
  findDarkMediaCloseIndex,
  findDarkRootInsertionIndex,
  stripBlockCommentsInLines,
} from '../token-dark-mode.js';

describe('stripBlockCommentsInLines', () => {
  it('blanks out inline /* ... */ comments while preserving line length', () => {
    const lines = ['  --foo: /* inline { } */ red;', 'keep-me'];
    const stripped = stripBlockCommentsInLines(lines);
    expect(stripped[0]?.length).toBe(lines[0]?.length);
    // Every brace inside the comment must be replaced with whitespace.
    expect(stripped[0]).not.toContain('{');
    expect(stripped[0]).not.toContain('}');
    expect(stripped[1]).toBe('keep-me');
  });

  it('tracks multi-line block comments across line boundaries', () => {
    const lines = ['/* start', ' * middle with { brace', ' */ end'];
    const stripped = stripBlockCommentsInLines(lines);
    // Every brace that lives inside the multi-line comment must be
    // blanked so depth counters downstream do not miscount.
    expect(stripped.join('\n')).not.toContain('{');
  });
});

describe('findDarkRootInsertionIndex', () => {
  it('returns null when no @media (prefers-color-scheme: dark) block exists', () => {
    expect(findDarkRootInsertionIndex([':root { --a: 1; }'])).toBeNull();
  });

  it('returns -1 when the @media block has no nested :root { }', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  /* no :root block — the scaffold drifted */',
      '}',
    ];
    expect(findDarkRootInsertionIndex(lines)).toBe(-1);
  });

  it('returns the nested :root close line index (not the outer @media close)', () => {
    const lines = [
      ':root { --light: 1; }',
      '',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --dark: 1;',
      '  }',
      '}',
    ];
    // The inner `:root {` opens on line 3, and its matching `}` is line 5.
    // The outer `@media {` close is line 6. Inserting at line 5 means
    // splicing the new line before the inner close, i.e. between the
    // last declaration and `  }`. Anything greater would land outside
    // the nested `:root { }`.
    const idx = findDarkRootInsertionIndex(lines);
    expect(idx).toBe(5);
  });

  it('handles a :root selector with its opening brace on the following line', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  :root',
      '  {',
      '    --dark: 1;',
      '  }',
      '}',
    ];
    expect(findDarkRootInsertionIndex(lines)).toBe(4);
  });

  it('ignores braces that sit inside block comments', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  /* a { b } c */',
      '  :root {',
      '    --dark: 1;',
      '  }',
      '}',
    ];
    // Without the comment-strip step the depth counter would treat the
    // `{` inside the comment as opening a new block and never re-enter
    // the nested :root. With it, the scan correctly lands at line 4
    // (the inner `:root`'s closing brace).
    expect(findDarkRootInsertionIndex(lines)).toBe(4);
  });
});

describe('findDarkMediaCloseIndex', () => {
  it('returns -1 when no @media block exists', () => {
    expect(findDarkMediaCloseIndex([':root { --a: 1; }'])).toBe(-1);
  });

  it('returns the line index of the outer @media close brace', () => {
    const lines = ['@media (prefers-color-scheme: dark) {', '  :root {', '    --a: 1;', '  }', '}'];
    expect(findDarkMediaCloseIndex(lines)).toBe(4);
  });

  it('correctly tracks nested braces before the outer close', () => {
    const lines = [
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      '    --a: 1;',
      '  }',
      '  /* sibling rule { */',
      '  .x { --b: 2; }',
      '}',
    ];
    expect(findDarkMediaCloseIndex(lines)).toBe(6);
  });
});
