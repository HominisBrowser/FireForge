// SPDX-License-Identifier: EUPL-1.2
/**
 * JavaScript: acorn parsing under the module and script goals, one walker,
 * tokens, comment blanking that keeps offsets, and the facts several
 * modules read from source (import specifiers, relative imports). Positions
 * are acorn's character offsets.
 */
import * as acorn from 'acorn';
import type * as estree from 'estree';
import { walk } from 'estree-walker';

/** An ESTree node with acorn's character offsets. */
export type Positioned<T extends estree.Node = estree.Node> = T & { start: number; end: number };

/** A comment acorn reported: its kind, text and offsets. */
export type JsComment = acorn.Comment;

/** `module` for ES modules; `script` for chrome subscripts, which have no import syntax. */
export type JsGoal = 'module' | 'script';

/** A parsed program with its comments. */
export interface ParsedProgram {
  readonly program: Positioned<estree.Program>;
  readonly comments: readonly JsComment[];
}

function options(goal: JsGoal, comments: JsComment[]): acorn.Options {
  return { sourceType: goal, ecmaVersion: 'latest', allowHashBang: true, onComment: comments };
}

/**
 * Parses JavaScript under one goal.
 *
 * @param source - The source text
 * @param goal - The parse goal
 * @throws acorn's SyntaxError when the source does not parse
 */
export function parseJs(source: string, goal: JsGoal): ParsedProgram {
  const comments: JsComment[] = [];
  // acorn's Program carries the ESTree shape and offsets at runtime but is a
  // nominally distinct type; this is the one place the two meet.
  const program = acorn.parse(source, options(goal, comments)) as acorn.Program &
    Positioned<estree.Program>;
  return { program, comments };
}

/**
 * Parses under the module goal, then the script goal.
 *
 * @param source - The source text
 * @returns The program, or undefined when neither goal parses
 */
export function parseEither(source: string): ParsedProgram | undefined {
  for (const goal of ['module', 'script'] as const) {
    try {
      return parseJs(source, goal);
    } catch {
      // Try the other goal.
    }
  }
  return undefined;
}

/**
 * Visits every node under `root`, parents first. `enter` receives the node
 * and its ancestors (outermost first); returning `false` skips the node's
 * children.
 *
 * @param root - Where to start
 * @param enter - Called for each node
 */
export function walkJs(
  root: estree.Node,
  enter: (node: Positioned, ancestors: readonly estree.Node[]) => boolean | undefined
): void {
  const ancestors: estree.Node[] = [];
  walk(root, {
    enter(node) {
      if (enter(node as Positioned, ancestors) === false) {
        this.skip();
        return;
      }
      ancestors.push(node);
    },
    leave() {
      ancestors.pop();
    },
  });
}

/** One token: acorn's type label (`name`, `` ` ``, `template`, `${`, ...) and its offsets. */
export interface JsToken {
  readonly label: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The tokens of a module, up to the first error: a file being edited keeps
 * what precedes the error.
 *
 * @param source - The source text
 */
export function jsTokens(source: string): JsToken[] {
  const tokens: JsToken[] = [];
  try {
    for (const token of acorn.tokenizer(source, options('module', []))) {
      tokens.push({ label: token.type.label, start: token.start, end: token.end });
    }
  } catch {
    // Keep the tokens read before the error.
  }
  return tokens;
}

function commentRanges(source: string, goal: JsGoal): JsComment[] | undefined {
  const comments: JsComment[] = [];
  try {
    const tokens = acorn.tokenizer(source, options(goal, comments));
    for (let token = tokens.getToken(); token.type !== acorn.tokTypes.eof;) {
      token = tokens.getToken();
    }
  } catch {
    return undefined;
  }
  return comments;
}

/**
 * Blanks comments with spaces, keeping newlines and offsets. acorn's
 * tokenizer decides what a comment is (module goal, then script), so a regex
 * literal holding `/*` or a string holding `//` is judged correctly.
 *
 * @param source - The source text
 * @returns The blanked source, or undefined when neither goal tokenizes
 */
export function blankJsCommentsParsed(source: string): string | undefined {
  const comments = commentRanges(source, 'module') ?? commentRanges(source, 'script');
  if (comments === undefined) return undefined;
  const chars = source.split('');
  for (const { start, end } of comments) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
    }
  }
  return chars.join('');
}

/**
 * {@link blankJsCommentsParsed}, falling back to a regex blank for source
 * acorn cannot tokenize (preprocessor directives, syntax errors). The
 * fallback keeps strings and does not model regex literals.
 *
 * @param source - The source text
 */
export function blankJsComments(source: string): string {
  return (
    blankJsCommentsParsed(source) ??
    source.replace(
      /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gm,
      (match) => (match.startsWith('/') ? match.replace(/[^\n]/g, ' ') : match)
    )
  );
}

/**
 * The 1-based line of a character offset.
 *
 * @param source - The text
 * @param offset - A character offset into it
 */
export function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = source.indexOf('\n'); i !== -1 && i < offset; i = source.indexOf('\n', i + 1)) {
    line++;
  }
  return line;
}

/**
 * The offset of the start of the line holding `offset`.
 *
 * @param text - The text
 * @param offset - A character offset into it
 */
export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

/**
 * The leading whitespace of the line holding `offset`.
 *
 * @param text - The text
 * @param offset - A character offset into it
 */
export function lineIndent(text: string, offset: number): string {
  return /^[ \t]*/.exec(text.slice(lineStart(text, offset)))?.[0] ?? '';
}

/**
 * Whether a node is a string literal.
 *
 * @param node - Any node, or nothing
 */
export function isStringLiteral(
  node: estree.Node | null | undefined
): node is Positioned<estree.SimpleLiteral & { value: string }> {
  return node?.type === 'Literal' && typeof node.value === 'string';
}

/** An import specifier and the 1-based line it is written on. */
export interface Specifier {
  readonly specifier: string;
  readonly line: number;
}

/**
 * A bare `Name: "resource://…"` property line, as added inside an existing
 * `defineESModuleGetters` map: the call's opener is not among the added
 * lines, so only the property line names the module.
 */
const GETTER_PROPERTY_LINE =
  /^\s*["']?[A-Za-z_$][\w$]*["']?\s*:\s*["']((?:resource|chrome|moz-src):\/\/[^"']+)["']\s*,?\s*$/;

/**
 * The module specifiers a source names: static, side-effect and dynamic
 * imports, `ChromeUtils.importESModule`, the values of a
 * `defineESModuleGetters` map, and bare getter-property lines. Text-level
 * on comment-blanked source, so it works on fragments such as the lines a
 * change adds.
 *
 * @param source - Source text or a fragment of it
 */
export function importSpecifiers(source: string): Specifier[] {
  const blanked = blankJsComments(source);
  const found = new Map<string, Specifier>();
  const add = (specifier: string | undefined, offset: number): void => {
    if (specifier === undefined || specifier === '') return;
    const line = lineAt(blanked, offset);
    found.set(`${specifier}\0${line}`, { specifier, line });
  };
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /ChromeUtils\.importESModule\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    for (const match of blanked.matchAll(pattern)) add(match[1], match.index);
  }
  for (const call of blanked.matchAll(/defineESModuleGetters\s*\([^{)]*\{/g)) {
    const open = call.index + call[0].length;
    let depth = 1;
    let close = open;
    for (; close < blanked.length && depth > 0; close++) {
      if (blanked[close] === '{') depth++;
      else if (blanked[close] === '}') depth--;
    }
    for (const literal of blanked.slice(open, close).matchAll(/["']([^"']+)["']/g)) {
      add(literal[1], open + literal.index);
    }
  }
  let offset = 0;
  for (const text of blanked.split('\n')) {
    add(GETTER_PROPERTY_LINE.exec(text)?.[1], offset);
    offset += text.length + 1;
  }
  return [...found.values()];
}

const RELATIVE_FALLBACK =
  /(?:\bimport\s*(?:\(\s*)?(?:[\s\S]*?\bfrom\s*)?|\bexport\s+(?:[\s\S]*?\bfrom\s*)?|(?:ChromeUtils\.import(?:ESModule)?|Cu\.import)\s*\(\s*)["'](?:\.\.?\/)/gm;

function isRelative(node: estree.Node | null | undefined): node is Positioned<estree.Literal> {
  return isStringLiteral(node) && (node.value.startsWith('./') || node.value.startsWith('../'));
}

function isChromeImport(node: estree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier') return false;
  const [object, member] = [callee.object.name, callee.property.name];
  return (
    (object === 'Cu' && member === 'import') ||
    (object === 'ChromeUtils' && (member === 'import' || member === 'importESModule'))
  );
}

/**
 * The 1-based lines of relative specifiers (`./`, `../`) in imports,
 * re-exports, dynamic imports and `ChromeUtils.import*` / `Cu.import`
 * calls. Source acorn cannot parse is scanned as comment-blanked text.
 *
 * @param source - JavaScript source
 */
export function relativeImportLines(source: string): number[] {
  const offsets: number[] = [];
  const parsed = parseEither(source);
  if (parsed === undefined) {
    const blanked = blankJsComments(source);
    for (const match of blanked.matchAll(RELATIVE_FALLBACK)) {
      offsets.push(match.index + match[0].length - 1);
    }
  } else {
    walkJs(parsed.program, (node) => {
      const sources =
        node.type === 'ImportDeclaration' ||
        node.type === 'ImportExpression' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration'
          ? [node.source]
          : node.type === 'CallExpression' && isChromeImport(node)
            ? [node.arguments[0] as estree.Node | undefined]
            : [];
      for (const candidate of sources) {
        if (isRelative(candidate)) offsets.push(candidate.start);
      }
    });
  }
  return [...new Set(offsets.map((offset) => lineAt(source, offset)))].sort((a, b) => a - b);
}
