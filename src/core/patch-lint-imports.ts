// SPDX-License-Identifier: EUPL-1.2
import type * as estree from 'estree';

import { stripJsComments } from '../utils/regex.js';
import { asEstree, parseModule, parseScript, walkAST } from './ast-utils.js';

const RELATIVE_IMPORT_FALLBACK_PATTERN =
  /(?:\bimport\s*(?:\(\s*)?(?:[\s\S]*?\bfrom\s*)?|\bexport\s+(?:[\s\S]*?\bfrom\s*)?|(?:ChromeUtils\.import(?:ESModule)?|Cu\.import)\s*\(\s*)["'](?:\.\.?\/)/m;

function literalString(node: estree.Node | null | undefined): string | undefined {
  if (!node || node.type !== 'Literal') return undefined;
  return typeof node.value === 'string' ? node.value : undefined;
}

function isRelativeSpecifier(value: string | undefined): boolean {
  return value !== undefined && (value.startsWith('./') || value.startsWith('../'));
}

function isChromeImportCall(node: estree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') return false;
  if (callee.object.name === 'Cu') {
    return callee.property.name === 'import';
  }
  return (
    callee.object.name === 'ChromeUtils' &&
    (callee.property.name === 'import' || callee.property.name === 'importESModule')
  );
}

/**
 * The source offsets of every relative specifier in `content`: static and
 * dynamic imports, re-exports, and `ChromeUtils.import*` / `Cu.import`
 * calls.
 */
function astRelativeImportOffsets(content: string, sourceType: 'module' | 'script'): number[] {
  const ast = sourceType === 'module' ? parseModule(content) : parseScript(content);
  const offsets: number[] = [];
  const record = (node: estree.Node | null | undefined): void => {
    if (node && isRelativeSpecifier(literalString(node))) {
      offsets.push(asEstree(node).start);
    }
  };

  walkAST(ast, {
    enter(node) {
      if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
        record(node.source);
      } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        record(node.source);
      } else if (node.type === 'CallExpression' && isChromeImportCall(node)) {
        const [first] = node.arguments;
        if (first?.type !== 'SpreadElement') record(first);
      }
    },
  });

  return offsets;
}

/** Converts source offsets to sorted, distinct 1-based line numbers. */
function offsetsToLines(content: string, offsets: readonly number[]): number[] {
  const lines = new Set<number>();
  for (const offset of offsets) {
    let line = 1;
    for (let i = content.indexOf('\n'); i !== -1 && i < offset; i = content.indexOf('\n', i + 1)) {
      line++;
    }
    lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * Returns the 1-based line numbers of the relative JS imports in `content`
 * (the line holding each `./` or `../` specifier), avoiding comment and
 * template false positives. Falls back to stripped-text matching for legacy
 * chrome scripts Acorn cannot parse.
 *
 * @param content - JS source
 */
export function relativeImportLines(content: string): number[] {
  for (const sourceType of ['module', 'script'] as const) {
    try {
      return offsetsToLines(content, astRelativeImportOffsets(content, sourceType));
    } catch {
      // Not parseable under this goal; try the next one, then the text fallback.
    }
  }

  const stripped = stripJsComments(content);
  const pattern = new RegExp(RELATIVE_IMPORT_FALLBACK_PATTERN.source, 'gm');
  const offsets: number[] = [];
  for (const match of stripped.matchAll(pattern)) {
    offsets.push(match.index + match[0].length - 1);
  }
  return offsetsToLines(stripped, offsets);
}
