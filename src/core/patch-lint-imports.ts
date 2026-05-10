// SPDX-License-Identifier: EUPL-1.2
import type * as estree from 'estree';

import { stripJsComments } from '../utils/regex.js';
import { parseModule, parseScript, walkAST } from './ast-utils.js';

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

function astHasRelativeImport(content: string, sourceType: 'module' | 'script'): boolean {
  const ast = sourceType === 'module' ? parseModule(content) : parseScript(content);
  let found = false;

  walkAST(ast, {
    enter(node) {
      if (found) {
        this.skip();
        return;
      }

      if (node.type === 'ImportDeclaration') {
        found = isRelativeSpecifier(literalString(node.source));
      } else if (node.type === 'ImportExpression') {
        found = isRelativeSpecifier(literalString(node.source));
      } else if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') {
        found = isRelativeSpecifier(literalString(node.source));
      } else if (node.type === 'CallExpression' && isChromeImportCall(node)) {
        found = isRelativeSpecifier(literalString(node.arguments[0]));
      }
    },
  });

  return found;
}

/**
 * Detects relative JS imports while avoiding comment/template false positives.
 * Falls back to stripped-text matching for legacy chrome scripts Acorn cannot parse.
 */
export function hasRelativeImport(content: string): boolean {
  try {
    return astHasRelativeImport(content, 'module');
  } catch (moduleError: unknown) {
    void moduleError;
  }

  try {
    return astHasRelativeImport(content, 'script');
  } catch (scriptError: unknown) {
    void scriptError;
  }

  return RELATIVE_IMPORT_FALLBACK_PATTERN.test(stripJsComments(content));
}
