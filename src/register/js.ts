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
import {
  isStringLiteral,
  lineIndent,
  lineStart,
  parseJs,
  type Positioned,
  walkJs,
} from '../syntax/index.js';

const GUARD = /typeof\s+\w+\s*!==\s*"undefined"/;
/** Words that cannot start an expression chain: `class.init` is a syntax error. */
const RESERVED_WORDS = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
]);
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
  const root = leadingName(expression);
  if (RESERVED_WORDS.has(root)) {
    throw invalid(
      label,
      expression,
      `"${root}" is a reserved word and cannot start the expression`
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

/** The 1-based line of an offset, for messages. */
function lineOf(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}

/**
 * The body of the function a property or class method named by one of
 * `names` holds, such as `onLoad() { ... }` in an object literal. The first
 * name that any method has wins, so `names` is in order of preference.
 *
 * @throws `script-ambiguous-anchor` when that name belongs to several methods
 */
function findMethodBody(
  content: string,
  program: estree.Program,
  names: readonly string[],
  file: string
): Positioned<estree.BlockStatement> | undefined {
  const found: { name: string; body: Positioned<estree.BlockStatement> }[] = [];
  walkJs(program, (node) => {
    if (
      (node.type === 'Property' || node.type === 'MethodDefinition') &&
      !node.computed &&
      node.key.type === 'Identifier' &&
      names.includes(node.key.name) &&
      (node.value.type === 'FunctionExpression' || node.value.type === 'ArrowFunctionExpression') &&
      node.value.body.type === 'BlockStatement'
    ) {
      found.push({
        name: node.key.name,
        body: node.value.body as Positioned<estree.BlockStatement>,
      });
    }
    return undefined;
  });
  const name = names.find((candidate) => found.some((method) => method.name === candidate));
  const candidates = found.filter((method) => method.name === name);
  if (candidates.length > 1) {
    const lines = candidates.map((method) => lineOf(content, method.body.start)).join(', ');
    throw new FireForgeError(
      'script-ambiguous-anchor',
      `${file} has ${candidates.length} ${name} methods (lines ${lines}); FireForge cannot tell which one to edit.`,
      { hint: `Add the call to the right ${name} by hand.` }
    );
  }
  return candidates[0]?.body;
}

/** The text of a string literal argument: a quoted string or a template without substitutions. */
function stringArgument(node: estree.Node | undefined): string | undefined {
  if (isStringLiteral(node)) return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** The URL of a `loadSubScript("…")` call with a string-literal URL, else undefined. */
function loadedScript(node: estree.Node): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const { callee } = node;
  const name =
    callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier'
      ? callee.property.name
      : callee.type === 'Identifier'
        ? callee.name
        : undefined;
  return name === 'loadSubScript' ? stringArgument(node.arguments[0]) : undefined;
}

/** Whether anything under `root` is a `loadSubScript` call with a string-literal URL. */
function loadsScript(root: estree.Node): boolean {
  let found = false;
  walkJs(root, (node) => {
    if (loadedScript(node) !== undefined) found = true;
    return !found;
  });
  return found;
}

/**
 * Parses an edit's result again, so an edit that broke the file is refused
 * instead of written.
 */
function parsed(next: string, file: string): string {
  try {
    parseJs(next, 'script');
  } catch (error) {
    throw new FireForgeError(
      'script-edit-invalid',
      `The edit would leave ${file} unparseable: ${toError(error).message}`,
      { hint: `Make the change in ${file} by hand.` }
    );
  }
  return next;
}

/**
 * Adds a guarded `loadSubScript` for `name` after the last existing loader
 * in browser-main.js (a `try` block or statement that calls `loadSubScript`
 * with a string-literal URL), or, when the file loads nothing yet, at the
 * end of its one top-level function.
 *
 * @param content - browser-main.js
 * @param name - The subscript, without `.js`
 * @param marker - The comment marker the lint rules look for, such as `MYBROWSER:`
 * @returns The new text, or undefined when a `loadSubScript` call already loads it
 * @throws `script-no-anchor` when there is no loader and not exactly one top-level function
 */
export function addSubscript(content: string, name: string, marker: string): string | undefined {
  const file = 'browser-main.js';
  const program = parseScript(content, file);
  const wanted = `/content/${name}.js`;
  const urls: string[] = [];
  walkJs(program, (node) => {
    const url = loadedScript(node);
    if (url !== undefined) urls.push(url);
    return undefined;
  });
  if (urls.some((url) => url.endsWith(wanted))) return undefined;
  const loaders: { start: number; end: number }[] = [];
  walkJs(program, (node) => {
    if (node.type === 'TryStatement' && loadsScript(node.block)) loaders.push(node);
    else if (node.type === 'ExpressionStatement' && loadedScript(node.expression) !== undefined) {
      loaders.push(node);
    }
    return undefined;
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
  if (last !== undefined) {
    return parsed(insertBlock(content, { at: 'after', node: last }, block), file);
  }
  const functions = program.body.filter(
    (statement): statement is Positioned<estree.FunctionDeclaration> =>
      statement.type === 'FunctionDeclaration'
  );
  const only = functions.length === 1 ? functions[0] : undefined;
  if (only === undefined) {
    throw new FireForgeError(
      'script-no-anchor',
      `${file} has no loadSubScript call and not exactly one top-level function to add the load to.`,
      { hint: 'Add the subscript load to browser-main.js by hand.' }
    );
  }
  const body = only.body as Positioned<estree.BlockStatement>;
  const end = body.body.at(-1) as Positioned<estree.Statement> | undefined;
  const place: Anchor = end === undefined ? { at: 'first', body } : { at: 'after', node: end };
  return parsed(insertBlock(content, place, block), file);
}

/** Whether `body` calls `expression`; comments and strings never count. */
function alreadyCalls(content: string, body: estree.Node, expression: string): boolean {
  const callee = expression.replace(/\(\)$/, '');
  let found = false;
  walkJs(body, (node) => {
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
  const file = 'browser-init.js';
  const program = parseScript(content, file);
  const body = findMethodBody(content, program, ['onLoad'], file);
  if (body === undefined) {
    throw new FireForgeError('script-no-anchor', 'browser-init.js has no onLoad method.', {
      hint: 'Add the init call to browser-init.js by hand.',
    });
  }
  if (alreadyCalls(content, body, expression)) return undefined;
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
  return parsed(
    insertBlock(content, place, guardedBlock('init', expression, options.marker)),
    file
  );
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
  const file = 'browser-init.js';
  const program = parseScript(content, file);
  const body = findMethodBody(content, program, ['onUnload', 'uninit'], file);
  if (body === undefined) {
    throw new FireForgeError(
      'script-no-anchor',
      'browser-init.js has no onUnload or uninit method.',
      { hint: 'Add the destroy call to browser-init.js by hand.' }
    );
  }
  if (alreadyCalls(content, body, expression)) return undefined;
  const first = body.body[0] as Positioned<estree.Statement> | undefined;
  const place: Anchor = first !== undefined ? { at: 'before', node: first } : { at: 'first', body };
  return parsed(insertBlock(content, place, guardedBlock('destroy', expression, marker)), file);
}
