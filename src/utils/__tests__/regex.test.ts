// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  countRawCssColors,
  escapeRegex,
  hasRawCssColors,
  stripJsComments,
  stripJsCommentsParsed,
} from '../regex.js';

describe('regex helpers', () => {
  it('escapes regex metacharacters', () => {
    expect(escapeRegex('a+b?.js')).toBe('a\\+b\\?\\.js');
  });

  it('detects and counts raw CSS color values', () => {
    const css = 'color: #fff; background: rgb(0, 0, 0); border-color: hsl(0 0% 0%);';
    expect(hasRawCssColors(css)).toBe(true);
    expect(countRawCssColors(css)).toBe(3);
  });

  it('strips JS comments while preserving string literals', () => {
    const source = 'const url = "https://example.test"; // comment\n/* block */ const ok = true;';
    const stripped = stripJsComments(source);
    expect(stripped).toContain('"https://example.test"');
    expect(stripped).not.toContain('// comment');
    expect(stripped).not.toContain('/* block */');
  });

  it('tokenizes a script-only source as a script before falling back to the regex strip', () => {
    // The legacy octal escape is a module-goal tokenizer error. The regex
    // fallback would read the `//` inside the regex literal as a comment.
    const source = 'var s = "\\07"; var re = /a\\/\\//; // gone\n';
    const stripped = stripJsComments(source);
    expect(stripped).toContain('var re = /a\\/\\//;');
    expect(stripped).not.toContain('gone');
  });

  it('stripJsCommentsParsed returns null when neither goal tokenizes', () => {
    expect(stripJsCommentsParsed('var a = 1; @@\n')).toBeNull();
    expect(stripJsCommentsParsed('a(); // c\n')).toBe('a();     \n');
  });
});
