// SPDX-License-Identifier: EUPL-1.2
/**
 * CSS: a stylesheet read just far enough to judge and edit it. The rule
 * blocks (with their selectors and positions), the comments, the property
 * declarations, `var()` references and raw colours in values. Comments and
 * string contents never count as structure. Lines and columns are
 * zero-based. The text is never regenerated: edits splice lines.
 */

/** One `selector { ... }` rule or at-rule block. */
export interface CssBlock {
  /** Selector or at-rule prelude, comments removed and whitespace collapsed. */
  selector: string;
  open: number;
  openCol: number;
  /** Line of the closing brace, or -1 when the block never closes. */
  close: number;
  closeCol: number;
  parent: CssBlock | undefined;
}

/** A block comment: the lines it starts and ends on, and its text between `/*` and `*\/`. */
export interface CssComment {
  text: string;
  start: number;
  end: number;
}

/** One `name: value` declaration inside a block. */
export interface CssDeclaration {
  /** The property as written; a custom property keeps its case and leading `--`. */
  name: string;
  /** The value, comments blanked, trimmed. */
  value: string;
  /** The line of the name. */
  line: number;
  /** The block holding it. */
  block: CssBlock;
  /** Offsets of the value in the text. */
  valueStart: number;
  valueEnd: number;
}

/** A parsed stylesheet. */
export interface Stylesheet {
  lines: string[];
  /** The text with comments and string contents blanked, split into the same lines. */
  code: string[];
  blocks: CssBlock[];
  comments: CssComment[];
  /** Property and custom-property declarations, in file order. */
  declarations: CssDeclaration[];
  /** The line of a character offset. */
  lineOf(offset: number): number;
}

interface Masked {
  /** The text with comment and string contents blanked, same length and line structure. */
  code: string;
  /** The text with only the comments blanked. */
  plain: string;
  comments: { start: number; end: number }[];
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, ' ');
}

/**
 * Blanks comments and string contents, remembering where the comments
 * were. A linear scan; an unclosed `/*` runs to the end of the text.
 */
function mask(text: string): Masked {
  const parts: string[] = [];
  const plain: string[] = [];
  const comments: { start: number; end: number }[] = [];
  let copied = 0;
  let plainCopied = 0;
  let i = 0;
  while (i < text.length) {
    const char = text.charAt(i);
    if (char === '/' && text.charAt(i + 1) === '*') {
      const close = text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : close + 2;
      parts.push(text.slice(copied, i), blank(text.slice(i, end)));
      plain.push(text.slice(plainCopied, i), blank(text.slice(i, end)));
      comments.push({ start: i, end });
      copied = plainCopied = i = end;
    } else if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < text.length && text.charAt(end) !== char && text.charAt(end) !== '\n') {
        end += text.charAt(end) === '\\' ? 2 : 1;
      }
      if (text.charAt(end) === char) {
        parts.push(text.slice(copied, i + 1), blank(text.slice(i + 1, end)));
        copied = end;
        i = end + 1;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  parts.push(text.slice(copied));
  plain.push(text.slice(plainCopied));
  return { code: parts.join(''), plain: plain.join(''), comments };
}

/**
 * Blanks block comments with spaces, keeping newlines and offsets. A `/*`
 * inside a string is not a comment; an unclosed one runs to the end.
 *
 * @param text - Stylesheet text
 */
export function blankCssComments(text: string): string {
  return mask(text).plain;
}

const DECLARATION = /^\s*(--[\w-]+|-?[a-zA-Z][\w-]*)\s*:/;

/**
 * Parses a stylesheet. Never throws: a block that never closes has `close`
 * -1, and text it does not understand is skipped. A statement inside a block
 * ended by `;` or `}` is a declaration; one ended by `{` is a selector or
 * an at-rule prelude, so `a:hover { … }` is never read as a declaration.
 *
 * @param text - CSS text
 */
export function parseCss(text: string): Stylesheet {
  const { code, plain, comments: spans } = mask(text);
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  const column = (offset: number): number => offset - (starts[lineOf(offset)] ?? 0);

  const blocks: CssBlock[] = [];
  const declarations: CssDeclaration[] = [];
  const stack: CssBlock[] = [];
  let statement = 0;
  let parens = 0;
  const flush = (end: number): void => {
    const found = DECLARATION.exec(code.slice(statement, end));
    const block = stack.at(-1);
    if (found === null || block === undefined) return;
    const name = found[1] ?? '';
    const valueStart = statement + found[0].length;
    declarations.push({
      name,
      value: plain.slice(valueStart, end).trim(),
      line: lineOf(statement + found[0].indexOf(name)),
      block,
      valueStart,
      valueEnd: end,
    });
  };
  for (let i = 0; i < code.length; i++) {
    const char = code.charAt(i);
    if (char === '(') parens++;
    else if (char === ')') parens = Math.max(0, parens - 1);
    else if (parens > 0) continue;
    else if (char === '{') {
      const block: CssBlock = {
        selector: plain.slice(statement, i).replace(/\s+/g, ' ').trim(),
        open: lineOf(i),
        openCol: column(i),
        close: -1,
        closeCol: -1,
        parent: stack.at(-1),
      };
      blocks.push(block);
      stack.push(block);
      statement = i + 1;
    } else if (char === ';') {
      flush(i);
      statement = i + 1;
    } else if (char === '}') {
      flush(i);
      const block = stack.pop();
      if (block !== undefined) {
        block.close = lineOf(i);
        block.closeCol = column(i);
      }
      statement = i + 1;
    }
  }
  return {
    lines: text.split('\n'),
    code: code.split('\n'),
    blocks,
    declarations,
    comments: spans.map((span) => ({
      text: text.slice(span.start + 2, Math.max(span.start + 2, span.end - 2)),
      start: lineOf(span.start),
      end: lineOf(span.end - 1),
    })),
    lineOf,
  };
}

/**
 * The custom-property declarations of a stylesheet (`--name: value`).
 *
 * @param sheet - A parsed stylesheet
 */
export function customProperties(sheet: Stylesheet): CssDeclaration[] {
  return sheet.declarations.filter((declaration) => declaration.name.startsWith('--'));
}

/** One `var(--name …)` reference. */
export interface CssVarReference {
  name: string;
  line: number;
  /** The reference supplies a fallback value. */
  fallback: boolean;
}

/**
 * The `var()` references of a stylesheet, outside comments and strings.
 *
 * @param sheet - A parsed stylesheet
 */
export function cssVarReferences(sheet: Stylesheet): CssVarReference[] {
  const found: CssVarReference[] = [];
  for (const [line, text] of sheet.code.entries()) {
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      found.push({ name: match[1] ?? '', line, fallback: match[2] !== undefined });
    }
  }
  return found;
}

/**
 * The `var()` references to custom properties that are not design tokens:
 * not under `prefix`, not `accepted` by exact name, and not declared in the
 * stylesheet itself. Every occurrence, in file order.
 *
 * @param sheet - A parsed stylesheet
 * @param prefix - The token prefix, such as `--brand-`
 * @param accepted - Further names accepted by exact name
 */
export function foreignVariables(
  sheet: Stylesheet,
  prefix: string,
  accepted: ReadonlySet<string>
): CssVarReference[] {
  const declared = new Set(customProperties(sheet).map((declaration) => declaration.name));
  return cssVarReferences(sheet).filter(
    ({ name }) => !name.startsWith(prefix) && !accepted.has(name) && !declared.has(name)
  );
}

const RAW_COLOR =
  /(?<![\w-])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])|\b(?:rgba?|hsla?)\s*\(/g;

/**
 * The raw colours (hex, `rgb()`, `hsl()`) written in declaration values. A
 * `#` in a selector (`#add-button`), a string, a comment or a `url()` is
 * not a colour.
 *
 * @param sheet - A parsed stylesheet
 */
export function rawColors(sheet: Stylesheet): { line: number; text: string }[] {
  const code = sheet.code.join('\n');
  const found: { line: number; text: string }[] = [];
  for (const declaration of sheet.declarations) {
    const value = code
      .slice(declaration.valueStart, declaration.valueEnd)
      .replace(/\burl\([^)]*\)/gi, (url) => blank(url));
    for (const match of value.matchAll(RAW_COLOR)) {
      found.push({ line: sheet.lineOf(declaration.valueStart + match.index), text: match[0] });
    }
  }
  return found;
}
