// SPDX-License-Identifier: EUPL-1.2
/**
 * The line model every manifest format is parsed into and edited through: a
 * file is a list of lines that each remember their own line ending, so an
 * edit that does not touch a line leaves its bytes alone.
 */
import { FireForgeError } from '../kernel/errors.js';

/** One source line: its text without the line ending, and the ending it had (`''` on an unterminated last line). */
export interface SourceLine {
  text: string;
  eol: string;
}

/** The outcome of an edit: the new text, and whether it differs from the input. */
export interface ManifestEdit {
  text: string;
  changed: boolean;
}

/** An edit that places a line. */
export interface Placement extends ManifestEdit {
  /** The index of the first placed line, or of the existing entry when nothing changed. */
  line: number;
  /** The trimmed text of the entry the new one follows. */
  previous?: string;
  /** `after` named no usable anchor, so the entry went in sort order. */
  afterFallback?: boolean;
}

/**
 * Splits text into lines that keep their endings.
 *
 * @param text - Manifest text
 */
export function splitSource(text: string): SourceLine[] {
  const lines: SourceLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/gy;
  while (pattern.lastIndex < text.length) {
    const match = pattern.exec(text);
    if (match === null) break;
    lines.push({ text: match[1] ?? '', eol: match[2] ?? '' });
  }
  return lines;
}

/**
 * Joins lines back into text.
 *
 * @param lines - Lines from {@link splitSource} or {@link spliceLines}
 */
export function joinSource(lines: readonly SourceLine[]): string {
  return lines.map((line) => line.text + line.eol).join('');
}

/**
 * Replaces `deleteCount` lines at `index` with new lines that use the file's
 * own line ending. A file without a final line ending stays that way.
 *
 * @param lines - The current lines (not modified)
 * @param index - Where to splice
 * @param deleteCount - How many lines to drop
 * @param inserted - Text of the new lines
 */
export function spliceLines(
  lines: readonly SourceLine[],
  index: number,
  deleteCount: number,
  inserted: readonly string[]
): SourceLine[] {
  const eol = lines.find((line) => line.eol !== '')?.eol ?? '\n';
  const unterminated = lines.at(-1)?.eol === '';
  const next = [...lines];
  next.splice(index, deleteCount, ...inserted.map((text) => ({ text, eol })));
  return next.map((line, position) => ({
    text: line.text,
    eol: position === next.length - 1 && unterminated ? '' : line.eol || eol,
  }));
}

/**
 * A manifest edit that its file's structure does not allow.
 *
 * @param message - What is wrong
 * @param hint - What to do about it
 */
export function manifestError(message: string, hint?: string): FireForgeError {
  return new FireForgeError('manifest-edit', message, hint === undefined ? {} : { hint });
}

/**
 * Refuses a value that cannot be written inside a quoted literal as it is: a
 * quote character, a backslash (an escape) or a line break would produce
 * different or broken syntax.
 *
 * @param value - The text to put between quotes
 * @param what - What the value is, for the message
 * @param quote - The quote that will surround it (default `"`)
 * @returns The value, unchanged
 * @throws `manifest-edit` for a value with a quote, a backslash or a line break
 */
export function literalText(value: string, what: string, quote: '"' | "'" = '"'): string {
  if (/[\\\r\n]/.test(value) || value.includes(quote)) {
    throw manifestError(
      `${what} ${JSON.stringify(value)} contains a quote character, a backslash or a line break, which FireForge does not write into a manifest.`,
      'Add the entry by hand.'
    );
  }
  return value;
}

/** Mozbuild's list order: case-insensitive, ties broken by bytes. */
export function compareInsensitive(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Plain byte order, the order test manifests are written in. */
export function compareBytes(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Where `key` goes in a list of keys. When the list is sorted under one of
 * the two orders (the preferred one first), the key goes before the first
 * greater key; when the list follows neither, order means nothing and the key
 * goes last.
 *
 * @param keys - Existing keys in file order
 * @param key - The key to place
 * @param prefer - The order to try first
 * @returns An index from 0 to `keys.length`
 */
export function sortedInsertIndex(
  keys: readonly string[],
  key: string,
  prefer: 'insensitive' | 'bytes' = 'insensitive'
): number {
  const orders =
    prefer === 'insensitive'
      ? [compareInsensitive, compareBytes]
      : [compareBytes, compareInsensitive];
  const order = orders.find((compare) =>
    keys.every((item, i) => i === 0 || compare(keys[i - 1] ?? '', item) <= 0)
  );
  if (order === undefined) return keys.length;
  const index = keys.findIndex((item) => order(item, key) > 0);
  return index === -1 ? keys.length : index;
}

/** One string literal in a bracketed list. */
export interface ListItem {
  /** The text between the quotes. */
  value: string;
  line: number;
  /** Column range of the quoted literal, quotes included. */
  start: number;
  end: number;
  quote: '"' | "'";
  /** Nothing else is on its line except a comma and a comment, so a line edit can move it. */
  ownLine: boolean;
}

/** The string items of a list and where it ends. */
export interface StringListScan {
  items: ListItem[];
  endLine: number;
  /** The column of the closing bracket on `endLine`. */
  endColumn: number;
  /**
   * The first thing in the list that is not a plain string item (a name, a
   * call, a nested list, a concatenation, adjacent strings): where it starts
   * and its text. Undefined when every element is a quoted string.
   */
  unrecognised?: { line: number; text: string };
}

/** The column of the quote closing the literal that opens at `start`, or undefined when the line ends first. */
function literalEnd(text: string, start: number): number | undefined {
  const quote = text.charAt(start);
  let end = start + 1;
  while (end < text.length && text.charAt(end) !== quote) end += text.charAt(end) === '\\' ? 2 : 1;
  return end >= text.length ? undefined : end;
}

/** The list item for the literal on line `line` between columns `start` and `end` (its quotes). */
function listItem(text: string, line: number, start: number, end: number): ListItem {
  return {
    value: text.slice(start + 1, end),
    line,
    start,
    end: end + 1,
    quote: text.charAt(start) === "'" ? "'" : '"',
    ownLine: text.slice(0, start).trim() === '' && /^\s*,?\s*(?:#.*)?$/.test(text.slice(end + 1)),
  };
}

/**
 * Reads a bracketed list from just after its `[` and returns its string items
 * (nested lists excluded) and the line of the closing bracket. Comments and
 * brackets inside strings are not structure. Undefined when the list never closes.
 *
 * @param lines - The file's lines
 * @param line - The line of the opening bracket
 * @param column - The column just after the bracket
 */
export function scanStringList(
  lines: readonly SourceLine[],
  line: number,
  column: number
): StringListScan | undefined {
  const items: ListItem[] = [];
  let unrecognised: StringListScan['unrecognised'];
  // Open brackets of any kind: the list itself is the first.
  let depth = 1;
  // A string was the last token at the list's own level, so only `,` or `]` may follow.
  let afterString = false;
  for (let at = line; at < lines.length; at++) {
    const text = lines[at]?.text ?? '';
    const refuse = (c: number, char = text.charAt(c)): void => {
      unrecognised ??= {
        line: at,
        text: /^[^\s,\]]+/.exec(text.slice(c))?.[0].slice(0, 40) ?? char,
      };
    };
    for (let c = at === line ? column : 0; c < text.length; c++) {
      const char = text.charAt(c);
      if (char === '#') break;
      if (char === '"' || char === "'") {
        const end = literalEnd(text, c);
        if (end === undefined) return undefined;
        if (depth === 1) {
          if (afterString) refuse(c);
          afterString = true;
          items.push(listItem(text, at, c, end));
        }
        c = end;
      } else if ('([{'.includes(char)) {
        if (depth === 1) refuse(c);
        depth++;
      } else if (depth === 1 && ')}'.includes(char)) {
        refuse(c);
      } else if (')]}'.includes(char)) {
        if (--depth === 0) {
          return {
            items,
            endLine: at,
            endColumn: c,
            ...(unrecognised === undefined ? {} : { unrecognised }),
          };
        }
        if (depth === 1) afterString = false;
      } else if (char === ',') {
        if (depth === 1) afterString = false;
      } else if (depth === 1 && !/\s/.test(char)) {
        refuse(c);
      }
    }
  }
  return undefined;
}
