// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { parseScript } from '../ast-utils.js';
import {
  countBraceDepth,
  extractNameFromExpression,
  findInsertionAfterFireforgeBlocks,
  findMethodBody,
  findMethodBraceIndex,
  findNearestTryLine,
  tokenizeXhtml,
  validateWireName,
  walkToTryBlockEnd,
} from '../wire-utils.js';

describe('findMethodBraceIndex', () => {
  it('finds a simple method declaration', () => {
    const lines = ['function foo() {', '  bar();', '}'];
    const result = findMethodBraceIndex(lines, /\bfoo\s*\(/);
    expect(result).toEqual({ methodLine: 0, braceIndex: 0 });
  });

  it('handles brace on a separate line', () => {
    const lines = ['  async onLoad()', '  {', '    init();', '  }'];
    const result = findMethodBraceIndex(lines, /\bonLoad\s*\(/);
    expect(result).toEqual({ methodLine: 0, braceIndex: 1 });
  });

  it('returns null when method is not found', () => {
    const lines = ['function bar() {', '}'];
    expect(findMethodBraceIndex(lines, /\bfoo\s*\(/)).toBeNull();
  });

  it('falls back to the method line when no opening brace is found later', () => {
    const lines = ['  async onLoad()', '    init();'];
    const result = findMethodBraceIndex(lines, /\bonLoad\s*\(/);
    expect(result).toEqual({ methodLine: 0, braceIndex: 0 });
  });
});

describe('validateWireName', () => {
  it('accepts safe dotted names and call suffixes', () => {
    expect(() => {
      validateWireName('Services.focus.init()', 'initializer');
    }).not.toThrow();
  });

  it('rejects dangerous property segments anywhere in the chain', () => {
    expect(() => {
      validateWireName('Services.constructor.name', 'initializer');
    }).toThrow('must not contain "constructor" as a property segment');
  });
});

describe('walkToTryBlockEnd', () => {
  it('finds the end of a simple try-catch', () => {
    const lines = [
      '    try {',
      '      doStuff();',
      '    } catch (e) {',
      '      console.error(e);',
      '    }',
      '    nextStatement();',
    ];
    expect(walkToTryBlockEnd(lines, 0)).toBe(5);
  });

  it('handles nested braces', () => {
    const lines = [
      '    try {',
      '      if (x) {',
      '        doStuff();',
      '      }',
      '    } catch (e) {',
      '      console.error(e);',
      '    }',
    ];
    expect(walkToTryBlockEnd(lines, 0)).toBe(7);
  });
});

describe('findNearestTryLine', () => {
  it('finds try line searching backward', () => {
    const lines = ['    try {', '      typeof Foo !== "undefined"', '    } catch {}'];
    expect(findNearestTryLine(lines, 1, -1)).toBe(0);
  });

  it('returns -1 when no try is found', () => {
    const lines = ['    foo();', '    bar();'];
    expect(findNearestTryLine(lines, 0, -1)).toBe(-1);
  });
});

describe('findInsertionAfterFireforgeBlocks', () => {
  it('returns startLine when there are no fireforge blocks', () => {
    const lines = ['  {', '    regularCode();', '  }'];
    expect(findInsertionAfterFireforgeBlocks(lines, 1, 0)).toBe(1);
  });

  it('advances past a single fireforge try-catch block', () => {
    const lines = [
      '  onLoad() {',
      '    // Foo init \u2014 must be first',
      '    try {',
      '      if (typeof Foo !== "undefined") {',
      '        Foo.init();',
      '      }',
      '    } catch (e) {',
      '      console.error(e);',
      '    }',
      '    regularCode();',
    ];
    const result = findInsertionAfterFireforgeBlocks(lines, 1, 0);
    expect(result).toBe(9);
  });
});

describe('countBraceDepth', () => {
  it('counts simple braces', () => {
    expect(countBraceDepth('{ foo }', false)).toEqual({ depth: 0, inBlockComment: false });
    expect(countBraceDepth('{ foo', false)).toEqual({ depth: 1, inBlockComment: false });
  });

  it('ignores braces in strings', () => {
    expect(countBraceDepth('const s = "{"', false)).toEqual({ depth: 0, inBlockComment: false });
  });

  it('tracks block comment state', () => {
    const r1 = countBraceDepth('/* start {', false);
    expect(r1.inBlockComment).toBe(true);
    expect(r1.depth).toBe(0);

    const r2 = countBraceDepth('} end */', r1.inBlockComment);
    expect(r2.inBlockComment).toBe(false);
    expect(r2.depth).toBe(0);
  });

  it('ignores braces inside regex literals and template strings', () => {
    expect(countBraceDepth('const matcher = /{foo}/; {', false)).toEqual({
      depth: 1,
      inBlockComment: false,
    });
    expect(countBraceDepth('const tpl = `template { brace }`; {', false)).toEqual({
      depth: 1,
      inBlockComment: false,
    });
  });

  it('skips escaped characters while inside quoted strings', () => {
    expect(countBraceDepth('const quoted = "\\{"; {', false)).toEqual({
      depth: 1,
      inBlockComment: false,
    });
  });
});

describe('extractNameFromExpression', () => {
  it('extracts the leading identifier from dotted expressions', () => {
    expect(extractNameFromExpression('Services.focus.init()')).toBe('Services');
  });

  it('falls back to the full expression when no leading identifier matches', () => {
    expect(extractNameFromExpression('?.focus')).toBe('?.focus');
  });
});

describe('tokenizeXhtml', () => {
  it('classifies empty lines, preprocessor macros, and xml content', () => {
    expect(tokenizeXhtml(['', '  #include widgets.inc', '  <box id="main" />'])).toEqual([
      { type: 'empty', raw: '' },
      { type: 'macro', raw: '  #include widgets.inc' },
      { type: 'xml', raw: '  <box id="main" />' },
    ]);
  });
});

describe('findMethodBody', () => {
  it('finds the block body for a named property function', () => {
    const ast = parseScript('const handlers = { onLoad: function () { init(); } };');
    const body = findMethodBody(ast, 'onLoad');

    expect(body?.type).toBe('BlockStatement');
    expect(body?.body).toHaveLength(1);
  });

  it('accepts multiple candidate names and returns null when none match', () => {
    const ast = parseScript('const handlers = { onUnload: () => { cleanup(); } };');

    expect(findMethodBody(ast, ['missing', 'onUnload'])?.type).toBe('BlockStatement');
    expect(findMethodBody(ast, 'onLoad')).toBeNull();
  });
});
