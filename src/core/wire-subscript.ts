// SPDX-License-Identifier: EUPL-1.2
/**
 * browser-main.js — loadSubScript registration.
 */

import { join } from 'node:path';

import type * as estree from 'estree';
import MagicString from 'magic-string';

import { GeneralError } from '../errors/base.js';
import { BuildError } from '../errors/build.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import {
  type AcornESTreeNode,
  asEstree,
  detectIndent,
  getNodeSource,
  parseScript,
  walkAST,
} from './ast-utils.js';
import { withParserFallback } from './parser-fallback.js';
import {
  assertBraceBalancePreserved,
  findNearestTryLine,
  validateWireName,
  walkToTryBlockEnd,
} from './wire-utils.js';

const BROWSER_MAIN_JS = 'browser/base/content/browser-main.js';
const DEFAULT_MARKER = 'FIREFORGE:';

/**
 * AST-based implementation: finds the last try/catch containing
 * `loadSubScript` and inserts a new try/catch block after it.
 *
 * The inserted block carries a `// <MARKER>: wire-subscript ...` comment
 * so the emitted edit satisfies `lintModificationComments` (eval 1
 * Finding #9).
 */
export function addSubscriptAST(
  content: string,
  name: string,
  marker: string = DEFAULT_MARKER
): string {
  const ast = parseScript(content);
  const ms = new MagicString(content);

  // Collect all TryStatements containing loadSubScript
  const tryNodes: AcornESTreeNode<estree.TryStatement>[] = [];

  walkAST(ast, {
    enter(node) {
      if (node.type === 'TryStatement') {
        const n = asEstree<estree.TryStatement>(node);
        const src = getNodeSource(content, n);
        if (src.includes('loadSubScript')) {
          tryNodes.push(n);
        }
      }
    },
  });

  let insertPos: number;
  let indent: string;

  if (tryNodes.length > 0) {
    const lastTry = tryNodes[tryNodes.length - 1];
    if (!lastTry) throw new GeneralError('Unexpected empty tryNodes array');
    insertPos = lastTry.end;
    indent = detectIndent(content, lastTry.start);
  } else {
    // No existing loadSubScript — insert before last standalone closing brace
    // Use line-based search to avoid matching braces inside strings/comments
    const allLines = content.split('\n');
    let lastBrace = -1;
    for (let i = allLines.length - 1; i >= 0; i--) {
      if (allLines[i]?.trim() === '}') {
        lastBrace = allLines.slice(0, i).join('\n').length + 1;
        break;
      }
    }
    if (lastBrace === -1) {
      throw new BuildError('Could not find closing brace in browser-main.js');
    }
    insertPos = lastBrace;
    indent = detectIndent(content, lastBrace);
  }

  const block = [
    `${indent}// ${marker} wire-subscript ${name}`,
    `${indent}try {`,
    `${indent}  Services.scriptloader.loadSubScript("chrome://browser/content/${name}.js", this);`,
    `${indent}} catch (e) {`,
    `${indent}  console.error("Failed to load ${name}.js:", e);`,
    `${indent}}`,
  ].join('\n');

  ms.appendRight(insertPos, '\n' + block + '\n');
  return ms.toString();
}

/**
 * Legacy regex/line-based implementation preserved as fallback.
 */
export function legacyAddSubscript(
  content: string,
  name: string,
  marker: string = DEFAULT_MARKER
): string {
  const lines = content.split('\n');

  let lastSubScriptLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/loadSubScript/.test(lines[i] ?? '')) {
      lastSubScriptLine = i;
    }
  }

  let insertIndex: number;
  if (lastSubScriptLine !== -1) {
    const tryStart = findNearestTryLine(lines, lastSubScriptLine - 1, -1);
    insertIndex =
      tryStart !== -1
        ? walkToTryBlockEnd(lines, tryStart, { strict: true, context: BROWSER_MAIN_JS })
        : lastSubScriptLine + 1;
  } else {
    insertIndex = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i]?.trim() === '}') {
        insertIndex = i;
        break;
      }
    }
  }

  // Detect indent from surrounding code instead of hardcoding
  const refLine = lines
    .slice(0, insertIndex)
    .reverse()
    .find((l) => l.trim());
  const ind = refLine?.match(/^(\s*)/)?.[1] ?? '  ';
  const inner = ind + '  ';

  const block = [
    `${ind}// ${marker} wire-subscript ${name}`,
    `${ind}try {`,
    `${inner}Services.scriptloader.loadSubScript("chrome://browser/content/${name}.js", this);`,
    `${ind}} catch (e) {`,
    `${inner}console.error("Failed to load ${name}.js:", e);`,
    `${ind}}`,
  ];

  lines.splice(insertIndex, 0, ...block);
  return lines.join('\n');
}

/**
 * Adds a loadSubScript entry to browser-main.js with try/catch error handling.
 *
 * @param engineDir - Engine source root
 * @param name - Subscript name (without .js extension)
 * @returns true if added, false if already present
 */
export async function addSubscriptToBrowserMain(
  engineDir: string,
  name: string,
  marker: string = DEFAULT_MARKER
): Promise<boolean> {
  validateWireName(name, 'subscript name');
  const filePath = join(engineDir, BROWSER_MAIN_JS);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`${BROWSER_MAIN_JS} not found in engine`);
  }

  const content = await readText(filePath);

  // Idempotency check — include closing quote to avoid substring false positives
  if (content.includes(`content/${name}.js"`)) {
    return false;
  }

  const { value, usedFallback } = withParserFallback(
    () => addSubscriptAST(content, name, marker),
    () => legacyAddSubscript(content, name, marker),
    BROWSER_MAIN_JS,
    // Rethrow only the internal-invariant GeneralErrors ("Unexpected empty
    // …array"): those are programming bugs, and retrying the legacy scanner
    // cannot fix a broken invariant — it just buries the stack. Everything
    // else still falls back, which is load-bearing: the AST path raises a raw
    // acorn SyntaxError on chrome sources acorn cannot parse (preprocessor
    // directives), and BuildError when the file's shape is unexpected. Both
    // are exactly what the legacy scanner is here to handle.
    (error) => error instanceof GeneralError
  );

  if (usedFallback) {
    assertBraceBalancePreserved(content, value, BROWSER_MAIN_JS);
  }

  await writeText(filePath, value);
  return true;
}
