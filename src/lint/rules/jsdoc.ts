// SPDX-License-Identifier: EUPL-1.2
/**
 * JSDoc on the API of owned code: exported declarations of modules
 * (`jsdoc`), top-level declarations of chrome subscripts
 * (`chrome-script-jsdoc`), and the methods of those classes
 * (`jsdoc-class-method`). A declaration needs an attached `/** … *\/`
 * block naming every simple parameter, with `@returns` when the body returns
 * a value. Destructured, defaulted and rest parameters are not judged.
 */
import type * as estree from 'estree';

import { toError } from '../../kernel/errors.js';
import { type JsComment, lineAt, parseJs, type Positioned } from '../../syntax/index.js';

/** One JSDoc problem; `classMethod` marks those of `jsdoc-class-method`. */
export interface JsDocProblem {
  readonly line: number;
  readonly message: string;
  readonly classMethod: boolean;
}

type FunctionNode = estree.FunctionDeclaration | estree.FunctionExpression;

function attachedJsDoc(
  comments: readonly JsComment[],
  start: number,
  source: string
): JsComment | undefined {
  for (let i = comments.length - 1; i >= 0; i--) {
    const comment = comments[i];
    if (comment === undefined || comment.end > start) continue;
    if (comment.type !== 'Block' || !comment.value.startsWith('*')) return undefined;
    return /^\s*$/.test(source.slice(comment.end, start)) ? comment : undefined;
  }
  return undefined;
}

/** Skips a balanced `{ … }` type expression; quoted runs may hold braces. */
function skipType(doc: string, start: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = start; i < doc.length; i++) {
    const char = doc.charAt(i);
    if (quote !== undefined) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return i + 1;
  }
  return undefined;
}

/** The parameter names a JSDoc block documents; `opts.id` records `opts`. */
export function documentedParams(doc: string): string[] {
  const names: string[] = [];
  for (const tag of doc.matchAll(/@param\b/g)) {
    let i = tag.index + tag[0].length;
    while (/\s/.test(doc.charAt(i))) i++;
    if (doc.charAt(i) === '{') {
      const after = skipType(doc, i);
      if (after === undefined) continue;
      i = after;
      while (/\s/.test(doc.charAt(i))) i++;
    }
    if (doc.charAt(i) === '[') i++;
    const name = /^[A-Za-z_$][\w$]*/.exec(doc.slice(i))?.[0];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function isNode(value: unknown): value is estree.Node {
  return typeof value === 'object' && value !== null && 'type' in value;
}

/** Whether a direct `return` (not one in a nested function) carries a value. */
function returnsValue(node: estree.Node): boolean {
  if (node.type === 'ReturnStatement') return node.argument != null;
  if (
    node.type === 'FunctionDeclaration' ||
    node.type === 'FunctionExpression' ||
    node.type === 'ArrowFunctionExpression'
  ) {
    return false;
  }
  for (const [key, value] of Object.entries(node) as [string, unknown][]) {
    if (key === 'type') continue;
    const children: unknown[] = Array.isArray(value) ? value : [value];
    if (children.some((child) => isNode(child) && returnsValue(child))) return true;
  }
  return false;
}

interface Walk {
  readonly source: string;
  readonly comments: readonly JsComment[];
  readonly problems: JsDocProblem[];
}

function checkSignature(
  walk: Walk,
  fn: FunctionNode,
  doc: JsComment,
  subject: { label: string; line: number; classMethod: boolean; skipReturns?: boolean }
): void {
  const documented = documentedParams(doc.value);
  for (const param of fn.params) {
    if (param.type !== 'Identifier' || documented.includes(param.name)) continue;
    walk.problems.push({
      line: subject.line,
      classMethod: subject.classMethod,
      message: `${subject.label}: @param "${param.name}" is missing or misnamed in its JSDoc.`,
    });
  }
  if (subject.skipReturns !== true && returnsValue(fn.body) && !/@returns?\b/.test(doc.value)) {
    walk.problems.push({
      line: subject.line,
      classMethod: subject.classMethod,
      message: `${subject.label} returns a value but its JSDoc has no @returns.`,
    });
  }
}

function checkFunction(
  walk: Walk,
  fn: Positioned<estree.FunctionDeclaration>,
  start = fn.start
): void {
  const line = lineAt(walk.source, start);
  const label = `Function "${fn.id.name}" at line ${line}`;
  const doc = attachedJsDoc(walk.comments, start, walk.source);
  if (doc === undefined) {
    walk.problems.push({ line, classMethod: false, message: `${label} has no JSDoc comment.` });
    return;
  }
  checkSignature(walk, fn, doc, { label, line, classMethod: false });
}

function methodLabel(className: string, method: estree.MethodDefinition, name: string): string {
  if (method.kind === 'constructor') return `Constructor of class "${className}"`;
  const kind = method.kind === 'get' ? 'Getter' : method.kind === 'set' ? 'Setter' : 'Method';
  return `${method.static ? 'Static ' : ''}${kind} "${className}.${name}"`;
}

function checkMethods(walk: Walk, cls: Positioned<estree.ClassDeclaration>): void {
  const className = cls.id.name;
  for (const member of cls.body.body) {
    if (member.type !== 'MethodDefinition' || member.computed) continue;
    if (member.key.type !== 'Identifier') continue;
    const name = member.key.name;
    if (member.kind !== 'constructor' && name.startsWith('_')) continue;
    if (member.kind === 'constructor' && member.value.params.length === 0) continue;
    const start = (member as Positioned<estree.MethodDefinition>).start;
    const line = lineAt(walk.source, start);
    const doc = attachedJsDoc(walk.comments, start, walk.source);
    if (doc !== undefined && /@(?:private|internal)\b/.test(doc.value)) continue;
    const label = `${methodLabel(className, member, name)} at line ${line}`;
    if (doc === undefined) {
      walk.problems.push({ line, classMethod: true, message: `${label} has no JSDoc comment.` });
      continue;
    }
    if (member.kind === 'get') continue;
    checkSignature(walk, member.value, doc, {
      label,
      line,
      classMethod: true,
      skipReturns: member.kind === 'constructor' || member.kind === 'set',
    });
  }
}

function checkClass(walk: Walk, cls: Positioned<estree.ClassDeclaration>, start = cls.start): void {
  const line = lineAt(walk.source, start);
  if (attachedJsDoc(walk.comments, start, walk.source) === undefined) {
    walk.problems.push({
      line,
      classMethod: false,
      message: `Class "${cls.id.name}" at line ${line} has no JSDoc comment.`,
    });
  }
  checkMethods(walk, cls);
}

function checkVariable(
  walk: Walk,
  declaration: Positioned<estree.VariableDeclaration>,
  start = declaration.start
): void {
  if (attachedJsDoc(walk.comments, start, walk.source) !== undefined) return;
  const line = lineAt(walk.source, start);
  for (const declarator of declaration.declarations) {
    const name = declarator.id.type === 'Identifier' ? declarator.id.name : '<destructured>';
    walk.problems.push({
      line,
      classMethod: false,
      message: `Constant "${name}" at line ${line} has no JSDoc comment.`,
    });
  }
}

type TopLevel = Positioned<
  estree.FunctionDeclaration | estree.ClassDeclaration | estree.VariableDeclaration
>;

function checkDeclaration(walk: Walk, declaration: TopLevel, start?: number): void {
  if (declaration.type === 'FunctionDeclaration') checkFunction(walk, declaration, start);
  else if (declaration.type === 'ClassDeclaration') checkClass(walk, declaration, start);
  else checkVariable(walk, declaration, start);
}

function localDeclaration(
  body: readonly estree.Node[],
  name: string
): Positioned<estree.FunctionDeclaration | estree.ClassDeclaration | estree.VariableDeclaration> {
  const found = body.find(
    (statement) =>
      ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') &&
        statement.id.name === name) ||
      (statement.type === 'VariableDeclaration' &&
        statement.declarations.some((d) => d.id.type === 'Identifier' && d.id.name === name))
  );
  return found as TopLevel;
}

/**
 * JSDoc problems on the exports of an ES module: inline exports, whose
 * JSDoc attaches to `export`, and `export { a, B }` lists resolved to their
 * local declarations. Source that does not parse is one problem.
 *
 * @param source - The module source
 */
export function moduleJsDocProblems(source: string): JsDocProblem[] {
  let parsed;
  try {
    parsed = parseJs(source, 'module');
  } catch (error) {
    return [
      {
        line: 1,
        classMethod: false,
        message: `The module did not parse, so its JSDoc was not checked: ${toError(error).message}`,
      },
    ];
  }
  const walk: Walk = { source, comments: parsed.comments, problems: [] };
  const body = parsed.program.body as Positioned[];
  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration') continue;
    if (node.declaration) {
      checkDeclaration(walk, node.declaration as TopLevel, node.start);
      continue;
    }
    if (node.source) continue;
    for (const specifier of node.specifiers) {
      if (specifier.local.type !== 'Identifier') continue;
      const local = localDeclaration(body, specifier.local.name) as TopLevel | undefined;
      if (local !== undefined) checkDeclaration(walk, local);
    }
  }
  return walk.problems;
}

/**
 * JSDoc problems on the top-level functions and classes of a chrome
 * subscript.
 *
 * @param source - The script source
 * @returns The problems, or undefined when the source does not parse as a script
 */
export function scriptJsDocProblems(source: string): JsDocProblem[] | undefined {
  let parsed;
  try {
    parsed = parseJs(source, 'script');
  } catch {
    return undefined;
  }
  const walk: Walk = { source, comments: parsed.comments, problems: [] };
  for (const node of parsed.program.body as Positioned[]) {
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      checkDeclaration(walk, node);
    }
  }
  return walk.problems;
}
