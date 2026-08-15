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
import {
  type AcornESTreeNode,
  asEstree,
  detectIndent,
  getNodeSource,
  parseScript,
} from './ast-utils.js';
import { withParserFallback } from './parser-fallback.js';
import {
  assertBraceBalancePreserved,
  coerceToCall,
  extractNameFromExpression,
  findInsertionAfterFireforgeBlocks,
  findMethodBody,
  findMethodBraceIndex,
  validateWireName,
  walkToTryBlockEnd,
} from './wire-utils.js';

const BROWSER_INIT_JS = 'browser/base/content/browser-init.js';

/**
 * Default patch-lint marker used when a caller does not supply a
 * project-specific one. Kept as a constant so test fixtures and
 * fallback code paths agree on the shape.
 */
const DEFAULT_MARKER = 'FIREFORGE:';

/**
 * Default insertion point: after the last consecutive fireforge block, or at
 * the top of the method body when there is none.
 *
 * Both callers below — the `--after`-target-not-found fallthrough and the
 * no-`--after` default — ran a character-for-character copy of this ladder,
 * including both throw guards. `browser-init.js` is written through those two
 * independent paths and they MUST emit identical blocks, so having one
 * implementation enforces the invariant rather than merely tidying.
 */
function resolveDefaultInsertion(
  content: string,
  body: AcornESTreeNode<estree.BlockStatement>,
  fireforgeBlocks: AcornESTreeNode<estree.Statement>[]
): { insertPos: number; indent: string } {
  if (fireforgeBlocks.length > 0) {
    const lastBlock = fireforgeBlocks[fireforgeBlocks.length - 1];
    if (!lastBlock) throw new GeneralError('Unexpected empty fireforgeBlocks array');
    return { insertPos: lastBlock.end, indent: detectIndent(content, lastBlock.start) };
  }
  const firstStmt = body.body[0];
  if (firstStmt) {
    const insertPos = asEstree<estree.Statement>(firstStmt).start;
    return { insertPos, indent: detectIndent(content, insertPos) };
  }
  return { insertPos: body.start + 1, indent: '    ' };
}

/**
 * AST-based implementation: finds onLoad() method body, locates existing
 * fireforge init blocks (TryStatements containing typeof guards), and inserts
 * after the correct position.
 *
 * `marker` is prepended (uppercased) to the generated comment line so the
 * emitted block carries the patch-lint `// <MARKER>:` signature that
 * `lintModificationComments` looks for. Otherwise the first export after
 * `wire` trips `missing-modification-comment` on wire-generated edits —
 * exactly the eval 1 Finding #9 regression.
 */
export function addInitAST(
  content: string,
  expression: string,
  after?: string,
  marker: string = DEFAULT_MARKER
): string {
  const name = extractNameFromExpression(expression);
  // `validateWireName` accepts both `Foo.bar` and `Foo.bar()` shapes. The
  // template below interpolates the value verbatim, so a bare property
  // path compiles to `Foo.bar;` — a silent no-op, not a lifecycle
  // invocation. `coerceToCall` normalises to the function-call form so
  // the emitted block always invokes the hook the operator asked for.
  const callExpression = coerceToCall(expression);
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
      const tryNode = asEstree<estree.TryStatement>(stmt);
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
      ({ insertPos, indent } = resolveDefaultInsertion(content, body, fireforgeBlocks));
    }
  } else {
    // Default: insert after the last consecutive fireforge block at the start
    ({ insertPos, indent } = resolveDefaultInsertion(content, body, fireforgeBlocks));
  }

  const block = [
    `${indent}// ${marker} wire-init ${name} — must be first, before Firefox subsystem`,
    `${indent}// inits that reference native UI elements we hide.`,
    `${indent}try {`,
    `${indent}  if (typeof ${name} !== "undefined") {`,
    `${indent}    ${callExpression};`,
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
export function legacyAddInit(
  content: string,
  expression: string,
  after?: string,
  marker: string = DEFAULT_MARKER
): string {
  const name = extractNameFromExpression(expression);
  // See `addInitAST` for the rationale — the AST and fallback paths must
  // agree on whether the emitted block is a function call, otherwise
  // operators would see different behaviour depending on which parser
  // happened to handle their browser-init.js layout.
  const callExpression = coerceToCall(expression);
  const lines = content.split('\n');

  const onLoadRegex = /\b(?:async\s+)?onLoad\s*[(:]/;
  const found = findMethodBraceIndex(lines, onLoadRegex, { requireBrace: true });

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
        insertIndex = walkToTryBlockEnd(lines, tryStart, {
          strict: true,
          context: BROWSER_INIT_JS,
        });
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
    `${baseIndent}// ${marker} wire-init ${name} — must be first, before Firefox subsystem`,
    `${baseIndent}// inits that reference native UI elements we hide.`,
    `${baseIndent}try {`,
    `${inner}if (typeof ${name} !== "undefined") {`,
    `${inner2}${callExpression};`,
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
  after?: string,
  marker: string = DEFAULT_MARKER
): Promise<boolean> {
  validateWireName(expression, 'init expression');
  const filePath = join(engineDir, BROWSER_INIT_JS);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`${BROWSER_INIT_JS} not found in engine`);
  }

  const content = await readText(filePath);

  // Idempotency check — look for the coerced (call) form because that is
  // what the emitter writes. Matching against the raw input would miss a
  // previous `EvalStartup.init` invocation that the 0.16.0 coercion
  // already persisted as `EvalStartup.init()`.
  const callExpression = coerceToCall(expression);
  const initPattern = new RegExp(`(?:^|\\W)${escapeRegex(callExpression)}\\s*;?\\s*$`, 'm');
  if (initPattern.test(content)) {
    return false;
  }

  const { value, usedFallback } = withParserFallback(
    () => addInitAST(content, expression, after, marker),
    () => legacyAddInit(content, expression, after, marker),
    BROWSER_INIT_JS,
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
    assertBraceBalancePreserved(content, value, BROWSER_INIT_JS);
  }

  await writeText(filePath, value);
  return true;
}
