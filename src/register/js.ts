// SPDX-License-Identifier: EUPL-1.2
/**
 * Source edits to the browser's chrome scripts: the `loadSubScript` list in
 * browser-main.js and the lifecycle blocks of browser-init.js. Every edit
 * parses the file, so a file that does not parse is refused rather than
 * patched by guesswork.
 */
import type * as estree from 'estree';

import { usageError } from '../cli/command.js';
import { FireForgeError, toError } from '../kernel/errors.js';
import { escapeRegExp } from '../kernel/text.js';
import { lineIndent, lineStart, parseJs, type Positioned, walkJs } from '../syntax/index.js';

const GUARD = /typeof\s+\w+\s*!==\s*"undefined"/;
const DANGEROUS_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function invalid(label: string, value: string, rule: string): FireForgeError {
  return usageError(`Invalid ${label} "${value}": ${rule}.`);
}

function refuseDangerous(label: string, value: string): void {
  for (const segment of value.replace(/\(\)$/, '').split('.')) {
    if (DANGEROUS_SEGMENTS.has(segment)) {
      throw invalid(label, value, `"${segment}" is not allowed as a property segment`);
    }
  }
}

/**
 * Refuses a subscript name that could break out of the generated code, the
 * jar.mn entry or the directory it names a file in.
 *
 * @param name - The subscript name, without `.js`
 * @param label - What the value is called in the message
 */
export function validateWireName(name: string, label = 'subscript name'): void {
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
    throw invalid(
      label,
      name,
      'start with a letter or underscore and use only letters, digits, underscores and hyphens'
    );
  }
  refuseDangerous(label, name);
}

/**
 * Refuses an init or destroy expression that is not a dotted identifier
 * chain with an optional `()`, since it is written into the browser as code.
 *
 * @param expression - Such as `MyFeature.init` or `MyFeature.init()`
 * @param label - What the value is called in the message
 */
export function validateWireExpression(expression: string, label: string): void {
  if (!/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\(\))?$/.test(expression)) {
    throw invalid(
      label,
      expression,
      'use dotted identifiers (letters, digits, underscores, $), optionally ending in ()'
    );
  }
  refuseDangerous(label, expression);
}

/** The expression as a call: `Foo.init` becomes `Foo.init()`. */
export function asCall(expression: string): string {
  return expression.endsWith('()') ? expression : `${expression}()`;
}

function leadingName(expression: string): string {
  return /^[\w$]+/.exec(expression)?.[0] ?? expression;
}

function parseScript(content: string, file: string): Positioned<estree.Program> {
  try {
    return parseJs(content, 'script').program;
  } catch (error) {
    throw new FireForgeError(
      'script-unparseable',
      `${file} cannot be parsed: ${toError(error).message}`,
      { hint: 'Fix the file first; FireForge does not edit a script it cannot parse.' }
    );
  }
}

/** Where a block goes: after a statement, before one, or first in a body. */
type Anchor =
  | { at: 'after'; node: { start: number; end: number } }
  | { at: 'before'; node: { start: number } }
  | { at: 'first'; body: Positioned<estree.BlockStatement> };

function insertBlock(content: string, anchor: Anchor, block: (indent: string) => string[]): string {
  const lines = (indent: string): string => block(indent).join('\n');
  if (anchor.at === 'after') {
    const indent = lineIndent(content, anchor.node.start);
    return `${content.slice(0, anchor.node.end)}\n${lines(indent)}${content.slice(anchor.node.end)}`;
  }
  if (anchor.at === 'before') {
    const position = lineStart(content, anchor.node.start);
    const indent = lineIndent(content, anchor.node.start);
    return `${content.slice(0, position)}${lines(indent)}\n${content.slice(position)}`;
  }
  const open = anchor.body.start + 1;
  const indent = `${lineIndent(content, anchor.body.start)}  `;
  return `${content.slice(0, open)}\n${lines(indent)}${content.slice(open)}`;
}

function guardedBlock(
  kind: 'init' | 'destroy',
  expression: string,
  marker: string
): (indent: string) => string[] {
  const name = leadingName(expression);
  return (i) =>
    [
      `// ${marker} wire-${kind} ${name}`,
      'try {',
      `  if (typeof ${name} !== "undefined") {`,
      `    ${asCall(expression)};`,
      '  }',
      '} catch (e) {',
      `  console.error("${name} ${kind} failed:", e);`,
      '}',
    ].map((line) => i + line);
}

/**
 * The body of the function a property or class method of one of `names`
 * holds, such as `onLoad() { ... }` in an object literal.
 */
function findMethodBody(
  program: estree.Program,
  names: readonly string[]
): Positioned<estree.BlockStatement> | undefined {
  let found: Positioned<estree.BlockStatement> | undefined;
  walkJs(program, (node) => {
    if (
      found === undefined &&
      (node.type === 'Property' || node.type === 'MethodDefinition') &&
      !node.computed &&
      node.key.type === 'Identifier' &&
      names.includes(node.key.name) &&
      (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression') &&
      node.value.body.type === 'BlockStatement'
    ) {
      found = node.value.body as Positioned<estree.BlockStatement>;
    }
    return found === undefined;
  });
  return found;
}

/**
 * Adds a guarded `loadSubScript` for `name` after the last existing one in
 * browser-main.js, or at the end of the file's last block.
 *
 * @param content - browser-main.js
 * @param name - The subscript, without `.js`
 * @param marker - The comment marker the lint rules look for, such as `MYBROWSER:`
 * @returns The new text, or undefined when the subscript is already loaded
 */
export function addSubscript(content: string, name: string, marker: string): string | undefined {
  if (content.includes(`content/${name}.js"`)) return undefined;
  const program = parseScript(content, 'browser-main.js');
  const loaders: { start: number; end: number }[] = [];
  walkJs(program, (node) => {
    if (
      node.type === 'TryStatement' &&
      content.slice(node.start, node.end).includes('loadSubScript')
    ) {
      loaders.push(node);
    }
  });
  const outermost = loaders.filter(
    (inner) =>
      !loaders.some(
        (outer) => outer !== inner && outer.start <= inner.start && inner.end <= outer.end
      )
  );
  const last = outermost.at(-1);
  const block = (i: string): string[] =>
    [
      `// ${marker} wire-subscript ${name}`,
      'try {',
      `  Services.scriptloader.loadSubScript("chrome://browser/content/${name}.js", this);`,
      '} catch (e) {',
      `  console.error("Failed to load ${name}.js:", e);`,
      '}',
    ].map((line) => i + line);
  if (last !== undefined) return insertBlock(content, { at: 'after', node: last }, block);
  const close = content.lastIndexOf('\n}');
  if (close === -1) {
    throw new FireForgeError(
      'script-no-anchor',
      'browser-main.js has no closing brace to insert before.',
      { hint: 'Add the subscript load to browser-main.js by hand.' }
    );
  }
  return insertBlock(content, { at: 'before', node: { start: close + 1 } }, (i) => block(`${i}  `));
}

/** Whether the script calls `expression` anywhere; comments and strings never count. */
function alreadyCalls(content: string, program: estree.Program, expression: string): boolean {
  const callee = expression.replace(/\(\)$/, '');
  let found = false;
  walkJs(program, (node) => {
    if (node.type === 'CallExpression') {
      const target = node.callee as Positioned;
      if (content.slice(target.start, target.end) === callee) found = true;
    }
    return !found;
  });
  return found;
}

/** Whether `text` is the init block that `after` names: it guards on, or calls `init` of, that name. */
function initBlockOf(text: string, name: string): boolean {
  const target = escapeRegExp(name);
  return new RegExp(
    `(?<![\\w$.])typeof\\s+${target}(?![\\w$])|(?<![\\w$.])${target}\\.init\\(`
  ).test(text);
}

/**
 * Adds a guarded init call to `onLoad` in browser-init.js, after the block
 * of the subscript `after` names, else after the last init block already
 * there, else first.
 *
 * @param content - browser-init.js
 * @param expression - `Name.init` or `Name.init()`
 * @param options - `after` is a subscript name; `marker` is the comment marker
 * @returns The new text, or undefined when the call is already there
 */
export function addInit(
  content: string,
  expression: string,
  options: { after?: string | undefined; marker: string }
): string | undefined {
  const program = parseScript(content, 'browser-init.js');
  if (alreadyCalls(content, program, expression)) return undefined;
  const body = findMethodBody(program, ['onLoad']);
  if (body === undefined) {
    throw new FireForgeError('script-no-anchor', 'browser-init.js has no onLoad method.', {
      hint: 'Add the init call to browser-init.js by hand.',
    });
  }
  const statements = body.body as Positioned<estree.Statement>[];
  const blocks = statements.filter(
    (statement) =>
      statement.type === 'TryStatement' && GUARD.test(content.slice(statement.start, statement.end))
  );
  const named =
    options.after === undefined
      ? undefined
      : blocks.find((block) =>
          initBlockOf(content.slice(block.start, block.end), options.after ?? '')
        );
  const anchor = named ?? blocks.at(-1);
  const first = statements[0];
  const place: Anchor =
    anchor !== undefined
      ? { at: 'after', node: anchor }
      : first !== undefined
        ? { at: 'before', node: first }
        : { at: 'first', body };
  return insertBlock(content, place, guardedBlock('init', expression, options.marker));
}

/**
 * Adds a guarded destroy call first in `onUnload` (or `uninit`) of
 * browser-init.js, so teardown runs newest first.
 *
 * @param content - browser-init.js
 * @param expression - `Name.destroy` or `Name.destroy()`
 * @param marker - The comment marker
 * @returns The new text, or undefined when the call is already there
 */
export function addDestroy(
  content: string,
  expression: string,
  marker: string
): string | undefined {
  const program = parseScript(content, 'browser-init.js');
  if (alreadyCalls(content, program, expression)) return undefined;
  const body = findMethodBody(program, ['onUnload', 'uninit']);
  if (body === undefined) {
    throw new FireForgeError(
      'script-no-anchor',
      'browser-init.js has no onUnload or uninit method.',
      { hint: 'Add the destroy call to browser-init.js by hand.' }
    );
  }
  const first = body.body[0] as Positioned<estree.Statement> | undefined;
  const place: Anchor = first !== undefined ? { at: 'before', node: first } : { at: 'first', body };
  return insertBlock(content, place, guardedBlock('destroy', expression, marker));
}
