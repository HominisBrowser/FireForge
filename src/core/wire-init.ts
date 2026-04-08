// SPDX-License-Identifier: EUPL-1.2
/**
 * browser-init.js — init expression in onLoad().
 */

import { join } from 'node:path';

import type * as estree from 'estree';
import MagicString from 'magic-string';

import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';
import { type AcornESTreeNode, detectIndent, getNodeSource, parseScript } from './ast-utils.js';
import { withParserFallback } from './parser-fallback.js';
import {
  extractNameFromExpression,
  findInsertionAfterFireforgeBlocks,
  findMethodBody,
  findMethodBraceIndex,
  validateWireName,
  walkToTryBlockEnd,
} from './wire-utils.js';

const BROWSER_INIT_JS = 'browser/base/content/browser-init.js';

/**
 * AST-based implementation: finds onLoad() method body, locates existing
 * fireforge init blocks (TryStatements containing typeof guards), and inserts
 * after the correct position.
 */
export function addInitAST(content: string, expression: string, after?: string): string {
  const name = extractNameFromExpression(expression);
  const ast = parseScript(content);
  const ms = new MagicString(content);

  const body = findMethodBody(ast, 'onLoad');
  if (!body) {
    throw new BuildError('Could not find onLoad method body via AST');
  }

  // Collect fireforge try-catch blocks (those containing typeof guards)
  const fireforgeBlocks: AcornESTreeNode<estree.TryStatement>[] = [];
  for (const stmt of body.body) {
    if (stmt.type === 'TryStatement') {
      const tryNode = stmt as AcornESTreeNode<estree.TryStatement>;
      const src = getNodeSource(content, tryNode);
      if (/typeof\s+\w+\s*!==\s*"undefined"/.test(src)) {
        fireforgeBlocks.push(tryNode);
      }
    }
  }

  let insertPos: number;
  let indent: string;

  if (after) {
    // Find the specific fireforge block containing the --after target
    const targetBlock = fireforgeBlocks.find((block) => {
      const src = getNodeSource(content, block);
      return src.includes(`typeof ${after}`) || src.includes(`${after}.init(`);
    });

    if (targetBlock) {
      insertPos = targetBlock.end;
      indent = detectIndent(content, targetBlock.start);
    } else {
      // --after target not found: fall through to default (after last fireforge block)
      if (fireforgeBlocks.length > 0) {
        const lastBlock = fireforgeBlocks[fireforgeBlocks.length - 1];
        if (!lastBlock) throw new GeneralError('Unexpected empty fireforgeBlocks array');
        insertPos = lastBlock.end;
        indent = detectIndent(content, lastBlock.start);
      } else {
        // No fireforge blocks, insert at top of method body
        const firstStmt = body.body[0];
        if (firstStmt) {
          insertPos = (firstStmt as AcornESTreeNode<estree.Statement>).start;
          indent = detectIndent(content, insertPos);
        } else {
          insertPos = body.start + 1;
          indent = '    ';
        }
      }
    }
  } else {
    // Default: insert after the last consecutive fireforge block at the start
    if (fireforgeBlocks.length > 0) {
      const lastBlock = fireforgeBlocks[fireforgeBlocks.length - 1];
      if (!lastBlock) throw new GeneralError('Unexpected empty fireforgeBlocks array');
      insertPos = lastBlock.end;
      indent = detectIndent(content, lastBlock.start);
    } else {
      const firstStmt = body.body[0];
      if (firstStmt) {
        insertPos = (firstStmt as AcornESTreeNode<estree.Statement>).start;
        indent = detectIndent(content, insertPos);
      } else {
        insertPos = body.start + 1;
        indent = '    ';
      }
    }
  }

  const block = [
    `${indent}// ${name} init — must be first, before Firefox subsystem`,
    `${indent}// inits that reference native UI elements we hide.`,
    `${indent}try {`,
    `${indent}  if (typeof ${name} !== "undefined") {`,
    `${indent}    ${expression};`,
    `${indent}  }`,
    `${indent}} catch (e) {`,
    `${indent}  console.error("${name} init failed:", e);`,
    `${indent}}`,
  ].join('\n');

  ms.appendRight(insertPos, '\n' + block + '\n');
  return ms.toString();
}

/**
 * Legacy regex/line-based implementation preserved as fallback.
 */
export function legacyAddInit(content: string, expression: string, after?: string): string {
  const name = extractNameFromExpression(expression);
  const lines = content.split('\n');

  const onLoadRegex = /\b(?:async\s+)?onLoad\s*[(:]/;
  const found = findMethodBraceIndex(lines, onLoadRegex);

  if (!found) {
    throw new GeneralError(
      'Could not find "onLoad" method in browser-init.js.\n' +
        'FireForge was looking for a signature matching: \\b(?:async\\s+)?onLoad\\s*[(:]'
    );
  }

  const { braceIndex } = found;
  let insertIndex = braceIndex + 1;

  if (after) {
    // Try to find the specific --after target block
    let located = false;
    for (let i = braceIndex + 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (line.includes(`typeof ${after}`) || line.includes(`${after}.init(`)) {
        // Walk backward to find the enclosing try, including a preceding comment
        let tryStart = i;
        for (let k = i - 1; k > braceIndex; k--) {
          if (/\btry\s*\{/.test(lines[k] ?? '')) {
            tryStart = k;
            break;
          }
          if (/\/\//.test(lines[k] ?? '') && /\btry\s*\{/.test(lines[k + 1] ?? '')) {
            tryStart = k;
            break;
          }
        }
        insertIndex = walkToTryBlockEnd(lines, tryStart);
        located = true;
        break;
      }
    }
    // If --after target not found, fall through to default fireforge block scan
    if (!located) {
      insertIndex = findInsertionAfterFireforgeBlocks(lines, braceIndex + 1, braceIndex);
    }
  } else {
    insertIndex = findInsertionAfterFireforgeBlocks(lines, braceIndex + 1, braceIndex);
  }

  // Detect indent from surrounding code instead of hardcoding
  const refLine = lines
    .slice(0, insertIndex)
    .reverse()
    .find((l) => l.trim());
  const baseIndent = refLine?.match(/^(\s*)/)?.[1] ?? '    ';
  const inner = baseIndent + '  ';
  const inner2 = inner + '  ';

  const block = [
    `${baseIndent}// ${name} init — must be first, before Firefox subsystem`,
    `${baseIndent}// inits that reference native UI elements we hide.`,
    `${baseIndent}try {`,
    `${inner}if (typeof ${name} !== "undefined") {`,
    `${inner2}${expression};`,
    `${inner}}`,
    `${baseIndent}} catch (e) {`,
    `${inner}console.error("${name} init failed:", e);`,
    `${baseIndent}}`,
  ];

  lines.splice(insertIndex, 0, ...block);
  return lines.join('\n');
}

/**
 * Adds an init expression as the first statement(s) in gBrowserInit.onLoad()
 * in browser-init.js, after any previously-wired fireforge init blocks.
 *
 * @param engineDir - Engine source root
 * @param expression - The init expression (e.g., "MyComponent.init()")
 * @param after - Optional name to insert after (e.g., "MyComponent" to insert after its block)
 * @returns true if added, false if already present
 */
export async function addInitToBrowserInit(
  engineDir: string,
  expression: string,
  after?: string
): Promise<boolean> {
  validateWireName(expression, 'init expression');
  const filePath = join(engineDir, BROWSER_INIT_JS);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`${BROWSER_INIT_JS} not found in engine`);
  }

  const content = await readText(filePath);

  // Idempotency check — use word-boundary regex to avoid substring false positives
  const initPattern = new RegExp(`(?:^|\\W)${escapeRegex(expression)}\\s*;?\\s*$`, 'm');
  if (initPattern.test(content)) {
    return false;
  }

  const { value } = withParserFallback(
    () => addInitAST(content, expression, after),
    () => legacyAddInit(content, expression, after),
    BROWSER_INIT_JS
  );

  await writeText(filePath, value);
  return true;
}
