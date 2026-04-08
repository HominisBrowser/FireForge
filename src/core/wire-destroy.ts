// SPDX-License-Identifier: EUPL-1.2
/**
 * browser-init.js — destroy expression in onUnload()/uninit().
 */

import { join } from 'node:path';

import type * as estree from 'estree';
import MagicString from 'magic-string';

import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';
import { type AcornESTreeNode, detectIndent, parseScript } from './ast-utils.js';
import { withParserFallback } from './parser-fallback.js';
import {
  extractNameFromExpression,
  findMethodBody,
  findMethodBraceIndex,
  validateWireName,
} from './wire-utils.js';

const BROWSER_INIT_JS = 'browser/base/content/browser-init.js';

/**
 * AST-based implementation: finds onUnload()/uninit() method body and
 * inserts the destroy block at the top (LIFO ordering).
 */
export function addDestroyAST(content: string, expression: string): string {
  const name = extractNameFromExpression(expression);
  const ast = parseScript(content);
  const ms = new MagicString(content);

  const body = findMethodBody(ast, ['onUnload', 'uninit']);
  if (!body) {
    throw new BuildError('Could not find onUnload/uninit method body via AST');
  }

  // Insert at top of method body (LIFO ordering)
  const firstStmt = body.body[0] as AcornESTreeNode<estree.Statement> | undefined;
  let insertPos: number;
  let indent: string;

  if (firstStmt) {
    insertPos = firstStmt.start;
    indent = detectIndent(content, firstStmt.start);
  } else {
    // Empty method body — insert after opening {
    insertPos = body.start + 1;
    indent = '    ';
  }

  const block = [
    `${indent}// ${name} destroy`,
    `${indent}try {`,
    `${indent}  if (typeof ${name} !== "undefined") {`,
    `${indent}    ${expression};`,
    `${indent}  }`,
    `${indent}} catch (e) {`,
    `${indent}  console.error("${name} destroy failed:", e);`,
    `${indent}}`,
  ].join('\n');

  ms.appendRight(insertPos, block + '\n');
  return ms.toString();
}

/**
 * Legacy regex/line-based implementation preserved as fallback.
 */
export function legacyAddDestroy(content: string, expression: string): string {
  const name = extractNameFromExpression(expression);
  const lines = content.split('\n');

  const destroyRegex = /\b(?:async\s+)?(onUnload|uninit)\s*[(:]/;
  const found = findMethodBraceIndex(lines, destroyRegex);

  if (!found) {
    throw new GeneralError(
      'Could not find "onUnload" or "uninit" method in browser-init.js.\n' +
        'FireForge was looking for a signature matching: \\b(?:async\\s+)?(onUnload|uninit)\\s*[(:]'
    );
  }

  const insertIndex = found.braceIndex + 1;

  const block = [
    `    // ${name} destroy`,
    `    try {`,
    `      if (typeof ${name} !== "undefined") {`,
    `        ${expression};`,
    `      }`,
    `    } catch (e) {`,
    `      console.error("${name} destroy failed:", e);`,
    `    }`,
  ];

  lines.splice(insertIndex, 0, ...block);
  return lines.join('\n');
}

/**
 * Adds a destroy expression to the top of onUnload() or uninit() in
 * browser-init.js (LIFO ordering — newest first).
 *
 * @param engineDir - Engine source root
 * @param expression - The destroy expression (e.g., "MyComponent.destroy()")
 * @returns true if added, false if already present
 */
export async function addDestroyToBrowserInit(
  engineDir: string,
  expression: string
): Promise<boolean> {
  validateWireName(expression, 'destroy expression');
  const filePath = join(engineDir, BROWSER_INIT_JS);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`${BROWSER_INIT_JS} not found in engine`);
  }

  const content = await readText(filePath);

  // Idempotency check — use word-boundary regex to avoid substring false positives
  const destroyPattern = new RegExp(`(?:^|\\W)${escapeRegex(expression)}\\s*;?\\s*$`, 'm');
  if (destroyPattern.test(content)) {
    return false;
  }

  const { value } = withParserFallback(
    () => addDestroyAST(content, expression),
    () => legacyAddDestroy(content, expression),
    BROWSER_INIT_JS
  );

  await writeText(filePath, value);
  return true;
}
