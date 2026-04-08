// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import { asEstree, detectIndent, getNodeSource, parseScript, walkAST } from '../ast-utils.js';

describe('ast-utils', () => {
  it('parses script content and walks positioned ESTree nodes', () => {
    const content = 'function demo() {\n  const value = 1;\n}\n';
    const ast = parseScript(content);
    const identifiers: string[] = [];

    walkAST(ast, {
      enter(node) {
        const currentNode = asEstree(node);
        if (currentNode.type === 'Identifier') {
          identifiers.push(currentNode.name);
        }
      },
    });

    expect(identifiers).toEqual(['demo', 'value']);
  });

  it('detects indentation from an offset within the line', () => {
    const content = 'if (true) {\n    demo();\n}\n';

    expect(detectIndent(content, content.indexOf('demo'))).toBe('    ');
    expect(detectIndent(content, content.indexOf('if'))).toBe('');
  });

  it('extracts the raw source for a node range', () => {
    const content = 'const value = call(arg);\n';
    const ast = parseScript(content);
    let callSource = '';

    walkAST(ast, {
      enter(node) {
        const currentNode = asEstree(node);
        if (currentNode.type === 'CallExpression') {
          callSource = getNodeSource(content, currentNode);
        }
      },
    });

    expect(callSource).toBe('call(arg)');
  });
});
