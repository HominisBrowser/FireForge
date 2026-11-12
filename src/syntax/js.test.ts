// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  blankJsComments,
  blankJsCommentsParsed,
  importSpecifiers,
  jsTokens,
  lineIndent,
  lineStart,
  parseEither,
  parseJs,
  relativeImportLines,
  walkJs,
} from './js.js';

describe('parseJs and parseEither', () => {
  it('parses each goal and keeps comments', () => {
    const parsed = parseJs('#!/usr/bin/env node\n// c\nimport x from "y";\n', 'module');
    expect(parsed.program.body[0]?.type).toBe('ImportDeclaration');
    expect(parsed.comments.map((comment) => comment.value)).toEqual(['/usr/bin/env node', ' c']);
    expect(() => parseJs('import x from "y";', 'script')).toThrow();
  });

  it('falls back to the script goal and gives up on what neither parses', () => {
    expect(parseEither('with (a) {}')?.program.sourceType).toBe('script');
    expect(parseEither('#ifdef X\n')).toBeUndefined();
  });
});

describe('walkJs', () => {
  it('passes ancestors and skips the children of a node when told', () => {
    const { program } = parseJs('f(g(1)); h(2);', 'script');
    const seen: string[] = [];
    walkJs(program, (node, ancestors) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') return true;
      seen.push(`${node.callee.name}@${String(ancestors.length)}`);
      return node.callee.name !== 'f';
    });
    expect(seen).toEqual(['f@2', 'h@2']);
  });
});

describe('comment blanking', () => {
  it('blanks comments by the tokenizer, keeping offsets and regex literals', () => {
    const source = 'a = /\\/*x/; // c\nb = "//"; /* d\n */';
    expect(blankJsCommentsParsed(source)).toBe('a = /\\/*x/;     \nb = "//";     \n   ');
  });

  it('falls back to a regex blank for source that does not tokenize', () => {
    expect(blankJsCommentsParsed('@ // c\n')).toBeUndefined();
    expect(blankJsComments('@ // c\n"//"')).toBe('@     \n"//"');
  });
});

describe('positions', () => {
  it('finds the start and indentation of a line', () => {
    const text = 'a\n  bc\n';
    expect(lineStart(text, 4)).toBe(2);
    expect(lineIndent(text, 5)).toBe('  ');
  });

  it('tokenizes a module up to the first error', () => {
    expect(jsTokens('html`<b>${x}</b>`; @').map((token) => token.label)).toEqual([
      'name',
      '`',
      'template',
      '${',
      'name',
      '}',
      'template',
      '`',
      ';',
    ]);
  });
});

describe('importSpecifiers', () => {
  it('reads static, dynamic, ChromeUtils and getter-map specifiers with their lines', () => {
    const source = [
      'import { a } from "resource:///modules/A.sys.mjs";',
      '// import "resource:///modules/Commented.sys.mjs";',
      'const b = await import("chrome://b.mjs");',
      'ChromeUtils.defineESModuleGetters(lazy, {',
      '  C: "resource://gre/modules/C.sys.mjs",',
      '});',
    ].join('\n');
    expect(importSpecifiers(source)).toEqual([
      { specifier: 'resource:///modules/A.sys.mjs', line: 1 },
      { specifier: 'chrome://b.mjs', line: 3 },
      { specifier: 'resource://gre/modules/C.sys.mjs', line: 5 },
    ]);
  });

  it('reads a bare getter property line, as a change adds inside an existing map', () => {
    expect(importSpecifiers('  D: "resource:///modules/D.sys.mjs",')).toEqual([
      { specifier: 'resource:///modules/D.sys.mjs', line: 1 },
    ]);
  });
});

describe('relativeImportLines', () => {
  it.each([
    ['import { a } from "./a.sys.mjs";', [1]],
    ['import "../side.mjs";', [1]],
    ['const m = await import("./dyn.mjs");', [1]],
    ['export { a } from "./a.mjs";', [1]],
    ['export * from "../all.mjs";', [1]],
    ['import {\n  a,\n} from "./multi.mjs";', [3]],
    ['ChromeUtils.importESModule("./x.sys.mjs");', [1]],
    ['Cu.import("./old.jsm");', [1]],
    ['// import { a } from "./a.mjs";\n/* import "./b.mjs" */', []],
    ['const s = "import x from \'./a.mjs\'";', []],
    ['import { a } from "resource:///modules/a.sys.mjs";', []],
    ['#ifdef X\nimport { a } from "./a.mjs";\n#endif', [2]],
  ])('%j -> %j', (source, lines) => {
    expect(relativeImportLines(source)).toEqual(lines);
  });
});
