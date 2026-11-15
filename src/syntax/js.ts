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

/** A module URL a getter map or a bare getter line names. */
const GETTER_URL = /^(?:resource|chrome|moz-src):\/\//;

/** What stands in for the characters of a string or template literal in {@link maskJs}. */
const FILLER = '\u0001';

/** Source with comments blanked and string contents replaced by filler, and the literals it hid. */
interface Masked {
  /** Same length and line structure as the source; quotes are kept, their contents are filler. */
  readonly text: string;
  /** Each single- or double-quoted literal by the offset of its opening quote. */
  readonly literals: ReadonlyMap<number, string>;
}

/**
 * Masks what is not code, for source that does not parse: comments become
 * spaces and the contents of strings and templates become filler, so a
 * pattern over the result only sees real code. Offsets and newlines are
 * kept. A quoted string that is not closed on its line ends there; regex
 * literals are not modelled.
 */
function maskJs(source: string): Masked {
  const chars = source.split('');
  const literals = new Map<number, string>();
  const hide = (from: number, to: number, fill: string): void => {
    for (let i = from; i < to; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = fill;
    }
  };
  // Scans code from `i` to the end of the source, or to the `}` that closes a template substitution.
  const code = (start: number, substitution: boolean): number => {
    let depth = 0;
    let i = start;
    while (i < source.length) {
      const char = source.charAt(i);
      const next = source.charAt(i + 1);
      if (char === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end === -1 ? source.length : end;
        hide(i, stop, ' ');
        i = stop;
      } else if (char === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end === -1 ? source.length : end + 2;
        hide(i, stop, ' ');
        i = stop;
      } else if (char === '"' || char === "'") {
        let end = i + 1;
        while (
          end < source.length &&
          source.charAt(end) !== char &&
          !/[\r\n]/.test(source.charAt(end))
        ) {
          end += source.charAt(end) === '\\' ? 2 : 1;
        }
        const closed = source.charAt(end) === char;
        if (closed) literals.set(i, source.slice(i + 1, end));
        hide(i + 1, Math.min(end, source.length), FILLER);
        i = closed ? end + 1 : Math.min(end, source.length);
      } else if (char === '`') {
        i = template(i + 1);
      } else {
        if (substitution && char === '{') depth++;
        if (substitution && char === '}' && depth-- === 0) return i;
        i++;
      }
    }
    return i;
  };
  const template = (start: number): number => {
    let i = start;
    while (i < source.length && source.charAt(i) !== '`') {
      if (source.charAt(i) === '\\') {
        hide(i, i + 2, FILLER);
        i += 2;
      } else if (source.charAt(i) === '$' && source.charAt(i + 1) === '{') {
        hide(i, i + 2, FILLER);
        i = code(i + 2, true);
        hide(i, i + 1, FILLER);
        i++;
      } else {
        hide(i, i + 1, FILLER);
        i++;
      }
    }
    return i + 1;
  };
  code(0, false);
  return { text: chars.join(''), literals };
}

/** `Name: "scheme://…"` as a whole line, with a quoted or bare name. */
const GETTER_LINE = new RegExp(
  `^\\s*(?:["']${FILLER}+["']|[A-Za-z_$][\\w$]*)\\s*:\\s*(["'])${FILLER}+\\1\\s*,?\\s*$`
);

/**
 * The values of the properties of the map whose body starts at `open`: the
 * quoted text after each top-level colon, in masked text where braces in
 * strings and comments are not structure.
 */
function getterValues(
  text: string,
  open: number,
  literals: ReadonlyMap<number, string>,
  add: (specifier: string | undefined, offset: number) => void
): void {
  let depth = 1;
  let close = open;
  for (; close < text.length && depth > 0; close++) {
    if (text[close] === '{') depth++;
    else if (text[close] === '}') depth--;
  }
  let nesting = 0;
  let colon = -1;
  for (let at = open; at < close - 1; at++) {
    const char = text.charAt(at);
    if ('([{'.includes(char)) nesting++;
    else if (')]}'.includes(char)) nesting--;
    else if (char === ',' && nesting === 0) colon = -1;
    else if (char === ':' && nesting === 0 && colon === -1) {
      colon = at;
      const position = at + 1 + (/^\s*/.exec(text.slice(at + 1))?.[0].length ?? 0);
      const literal = literals.get(position);
      const after = text.slice(position + (literal?.length ?? 0) + 2, close);
      if (literal !== undefined && /^\s*[,}]/.test(after)) add(literal, position);
    }
  }
}

/** The specifiers of source that does not parse as a whole, found in its masked text. */
function textSpecifiers(
  source: string,
  add: (specifier: string | undefined, offset: number) => void
): void {
  const { text, literals } = maskJs(source);
  const quoted = `(["'])${FILLER}*\\1`;
  const patterns = [
    new RegExp(`\\bimport\\s+(?:[^'"]*?\\s+from\\s+)?${quoted}`, 'dg'),
    new RegExp(`\\bimport\\s*\\(\\s*${quoted}\\s*\\)`, 'dg'),
    new RegExp(`ChromeUtils\\.importESModule\\s*\\(\\s*${quoted}`, 'dg'),
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const open = match.indices?.[1]?.[0];
      if (open !== undefined) add(literals.get(open), match.index);
    }
  }
  for (const call of text.matchAll(/defineESModuleGetters\s*\([^{)]*\{/g)) {
    getterValues(text, call.index + call[0].length, literals, add);
  }
  let offset = 0;
  for (const line of text.split('\n')) {
    const match = GETTER_LINE.exec(line);
    const open = match === null ? undefined : line.indexOf(match[1] ?? '"', line.indexOf(':'));
    const value = open === undefined ? undefined : literals.get(offset + open);
    if (value !== undefined && GETTER_URL.test(value)) add(value, offset);
    offset += line.length + 1;
  }
}

/** The module specifiers of a program that parsed, read from its import and call nodes. */
function programSpecifiers(
  program: estree.Program,
  add: (specifier: string | undefined, offset: number) => void
): void {
  walkJs(program, (node) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression') {
      if (isStringLiteral(node.source)) add(node.source.value, node.start);
    } else if (node.type === 'CallExpression') {
      const { callee } = node;
      const member =
        callee.type === 'MemberExpression' &&
        !callee.computed &&
        callee.property.type === 'Identifier'
          ? callee.property.name
          : callee.type === 'Identifier'
            ? callee.name
            : undefined;
      const first = node.arguments[0];
      if (member === 'importESModule' && callee.type === 'MemberExpression') {
        const object = callee.object;
        if (
          object.type === 'Identifier' &&
          object.name === 'ChromeUtils' &&
          isStringLiteral(first)
        ) {
          add(first.value, node.start);
        }
      } else if (member === 'defineESModuleGetters') {
        const map = node.arguments[1];
        if (map?.type === 'ObjectExpression') {
          for (const property of map.properties) {
            if (property.type === 'Property' && isStringLiteral(property.value)) {
              add(property.value.value, property.value.start);
            }
          }
        }
      }
    } else if (
      node.type === 'LabeledStatement' &&
      node.body.type === 'ExpressionStatement' &&
      isStringLiteral(node.body.expression) &&
      GETTER_URL.test(node.body.expression.value)
    ) {
      // `Name: "resource://…"` is a getter-map line when the lines around it are not there.
      add(node.body.expression.value, node.body.expression.start);
    }
    return undefined;
  });
}

/**
 * The module specifiers a source names: static, side-effect and dynamic
 * imports, `ChromeUtils.importESModule`, the values of a
 * `defineESModuleGetters` map, and bare getter-property lines. A source
 * that parses as a program is read from its syntax tree, so import-looking
 * text in a string, template or comment is not a specifier and a quoted key
 * of a getter map is not a value. A fragment that does not parse (the lines
 * a change adds) is read as text with comments and string contents masked.
 *
 * @param source - Source text or a fragment of it
 */
export function importSpecifiers(source: string): Specifier[] {
  const found = new Map<string, Specifier>();
  const add = (specifier: string | undefined, offset: number): void => {
    if (specifier === undefined || specifier === '') return;
    const line = lineAt(source, offset);
    found.set(`${specifier}\0${line}`, { specifier, line });
  };
  const parsed = parseEither(source);
  if (parsed === undefined) textSpecifiers(source, add);
  else programSpecifiers(parsed.program, add);
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
