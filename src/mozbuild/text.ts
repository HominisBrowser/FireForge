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
  let depth = 1;
  for (let at = line; at < lines.length; at++) {
    const text = lines[at]?.text ?? '';
    for (let c = at === line ? column : 0; c < text.length; c++) {
      const char = text.charAt(c);
      if (char === '#') break;
      if (char === '"' || char === "'") {
        let end = c + 1;
        while (end < text.length && text.charAt(end) !== char)
          end += text.charAt(end) === '\\' ? 2 : 1;
        if (end >= text.length) return undefined;
        if (depth === 1) {
          items.push({
            value: text.slice(c + 1, end),
            line: at,
            start: c,
            end: end + 1,
            quote: char,
            ownLine:
              text.slice(0, c).trim() === '' && /^\s*,?\s*(?:#.*)?$/.test(text.slice(end + 1)),
          });
        }
        c = end;
      } else if (char === '[') {
        depth++;
      } else if (char === ']' && --depth === 0) {
        return { items, endLine: at };
      }
    }
  }
  return undefined;
}
