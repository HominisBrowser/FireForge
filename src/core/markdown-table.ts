// SPDX-License-Identifier: EUPL-1.2
/**
 * Minimal Markdown pipe-table parser/writer used by token-manager.
 *
 * This is **not** a general Markdown parser. It understands exactly the
 * slice of GitHub-flavoured Markdown that FireForge emits into token docs:
 *
 *   - Leading `|` per row, trailing `|` optional.
 *   - A separator row of `|---|---|...|` immediately after the header.
 *   - Fenced code blocks (``` / ~~~) are recognised and skipped so that
 *     literal `|` lines inside code samples are never mistaken for rows.
 *   - A table ends on the first non-pipe line (blank line, heading, prose).
 *   - Literal `|` and `\` inside a cell are expressed as `\|` and `\\`
 *     respectively. The parser treats any other backslash as a literal
 *     so prose-style backslashes in cell values (e.g. a Windows path)
 *     still round-trip. Unescaping happens at split time; serialization
 *     re-applies escapes so round-trips are exact for well-formed input.
 *
 * The parser returns **positional metadata** (`startLine`, `endLine`) so
 * callers can splice the table back into the surrounding document by
 * range instead of hand-rolled line counters. Mutation operations return
 * a fresh line array rather than mutating in place, matching the rest of
 * the file-patching code in this codebase.
 *
 * Fallback tolerance: rows with more cells than the header get their
 * overflow merged into the last column (using a literal `|` separator
 * between the merged values). This is for the rare case where a FireForge
 * writer emits an unescaped pipe — the parser still produces a consistent
 * cell count rather than desynchronising the table. On re-serialize the
 * merged cell's literal pipes are escaped, so a malformed input becomes
 * a well-formed output after one round trip.
 */

/**
 * A parsed Markdown pipe table.
 */
export interface MarkdownTable {
  /** Column headers, trimmed. Cells are in document order. */
  headers: string[];
  /**
   * Data rows. Each row is an array with exactly `headers.length` entries,
   * trimmed. Rows shorter than the header are right-padded with `''`;
   * longer rows have trailing cells merged into the last column so the
   * round-trip is faithful.
   */
  rows: string[][];
  /** 0-indexed line number of the header row in the source lines array. */
  startLine: number;
  /**
   * 0-indexed line number *after* the final data row. `lines.slice(
   * startLine, endLine)` yields exactly the table's lines.
   */
  endLine: number;
}

/**
 * Matches the table separator row: optional leading pipe, one or more
 * dash-only cells (with optional `:` alignment hints) separated by pipes,
 * optional trailing pipe, allowing whitespace around each cell.
 */
const SEPARATOR_ROW = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

/**
 * Returns `true` if the given line looks like a table row (starts with
 * `|`, ignoring leading whitespace). Does not validate cell contents —
 * that is the caller's job.
 */
function isPipeRow(line: string): boolean {
  return /^\s*\|/.test(line);
}

/**
 * Splits a pipe-delimited row into trimmed cell strings.
 *
 * Tolerates both `| a | b |` and `| a | b` (no trailing pipe). Leading
 * empty cells (from a leading `|`) are dropped. A trailing empty cell
 * (from a trailing `|`) is also dropped so that rows with and without
 * the trailing pipe produce the same cell count.
 *
 * Escape handling: `\|` is consumed as a literal `|` inside a cell, and
 * `\\` as a literal `\`. Any other backslash stays literal so prose-style
 * uses of `\` survive untouched. Splitting and unescaping happen in the
 * same pass so the returned cells are ready to hand back to callers.
 */
function splitRow(row: string): string[] {
  const trimmed = row.trim();
  const cells: string[] = [];
  let current = '';

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && i + 1 < trimmed.length) {
      const next = trimmed[i + 1];
      if (next === '|' || next === '\\') {
        current += next;
        i++;
        continue;
      }
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch ?? '';
  }
  cells.push(current);

  // Leading `|` gives an empty first segment; drop it.
  if (cells.length > 0 && cells[0] === '') {
    cells.shift();
  }

  // Trailing `|` gives an empty last segment; drop it.
  if (cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }

  return cells.map((cell) => cell.trim());
}

/**
 * Escapes a cell value so `serializeRow`'s pipe delimiters can be told
 * apart from literal `|` inside a cell on re-parse. `\` is escaped first
 * (to `\\`) so that the subsequent `|` → `\|` substitution cannot produce
 * an already-escaped sequence by accident — i.e. a cell containing
 * literal `\` followed by literal `|` round-trips as `\\\|`, which
 * unescape-on-split reads back as `\` + `|`, not as `\|`.
 */
function escapeCell(cell: string): string {
  return cell.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}

/**
 * Fits a row of cells against a target column count. Extra cells are
 * merged into the last column (so a stray `|` in a cell's value does not
 * desynchronise the table), and missing cells are padded with `''`.
 */
function fitRowToColumns(cells: string[], columnCount: number): string[] {
  if (columnCount <= 0) return [];

  if (cells.length === columnCount) {
    return cells;
  }

  if (cells.length < columnCount) {
    return [...cells, ...Array<string>(columnCount - cells.length).fill('')];
  }

  // cells.length > columnCount — merge overflow into the last column.
  const kept = cells.slice(0, columnCount - 1);
  const tail = cells.slice(columnCount - 1).join(' | ');
  return [...kept, tail];
}

/**
 * Locates the next Markdown table in `lines` starting at or after
 * `fromLine`, skipping fenced code blocks. Returns `null` when no table
 * is found.
 *
 * @param lines - The full document split by newline
 * @param fromLine - Line index to start scanning from (inclusive)
 */
export function findNextTable(lines: string[], fromLine: number): MarkdownTable | null {
  let inFence = false;
  let fenceMarker: string | null = null;

  for (let i = fromLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fenceMatch[1] ?? '```';
      } else if (fenceMarker && line.trim().startsWith(fenceMarker)) {
        inFence = false;
        fenceMarker = null;
      }
      continue;
    }
    if (inFence) continue;

    if (!isPipeRow(line)) continue;

    const separatorLine = lines[i + 1];
    if (separatorLine === undefined || !SEPARATOR_ROW.test(separatorLine)) continue;

    const headers = splitRow(line);
    if (headers.length === 0) continue;

    const rows: string[][] = [];
    let endLine = i + 2;
    for (let j = i + 2; j < lines.length; j++) {
      const rowLine = lines[j] ?? '';
      if (!isPipeRow(rowLine)) break;
      // Another separator line would signal a malformed table — bail.
      if (SEPARATOR_ROW.test(rowLine)) break;
      rows.push(fitRowToColumns(splitRow(rowLine), headers.length));
      endLine = j + 1;
    }

    return { headers, rows, startLine: i, endLine };
  }

  return null;
}

/**
 * Returns the first table whose header contains **all** of the provided
 * column names (case-sensitive, order-insensitive). Useful when several
 * pipe tables share a document and you want to select "the one with a
 * Mode column".
 */
export function findTableByColumns(
  lines: string[],
  requiredColumns: string[]
): MarkdownTable | null {
  let cursor = 0;
  for (;;) {
    const table = findNextTable(lines, cursor);
    if (!table) return null;

    const headerSet = new Set(table.headers);
    const matches = requiredColumns.every((column) => headerSet.has(column));
    if (matches) return table;

    cursor = table.endLine;
  }
}

/**
 * Returns the first table that appears **after** a heading matching the
 * given regex. The heading regex is applied to raw lines (no trimming)
 * so callers that want leading whitespace flexibility should include
 * `^\s*` or `^#+\s*` as appropriate.
 */
export function findTableAfterHeading(
  lines: string[],
  headingPattern: RegExp
): MarkdownTable | null {
  for (let i = 0; i < lines.length; i++) {
    if (headingPattern.test(lines[i] ?? '')) {
      return findNextTable(lines, i + 1);
    }
  }
  return null;
}

/**
 * Serialises a single row using the same `| a | b | c |` layout the rest
 * of the token docs use. The leading and trailing pipes are always emitted
 * so that concatenated rows line up consistently. Cell values containing
 * literal `|` or `\` are escaped as `\|` and `\\` respectively so the
 * output survives a round-trip through {@link findNextTable}.
 */
export function serializeRow(cells: string[]): string {
  if (cells.length === 0) return '|';
  return `| ${cells.map(escapeCell).join(' | ')} |`;
}

/**
 * Inserts a new row into `table.rows` at the given zero-based index. A
 * negative index counts from the end; `Infinity` appends. Mutates the
 * table object so callers using {@link rewriteTableRows} see the update.
 */
export function insertRow(table: MarkdownTable, cells: string[], index: number): void {
  const fitted = fitRowToColumns(cells, table.headers.length);
  const target = Math.max(0, Math.min(index, table.rows.length));
  table.rows.splice(target, 0, fitted);
}

/**
 * Produces a new `lines` array with the given table region replaced by a
 * freshly-serialized version of the table's current headers + rows. The
 * separator row is regenerated from the current header count so edits
 * that change the column count stay consistent.
 */
export function rewriteTableRows(lines: string[], table: MarkdownTable): string[] {
  const headerLine = serializeRow(table.headers);
  const separatorLine = serializeRow(table.headers.map(() => '---'));
  const rowLines = table.rows.map((row) => serializeRow(row));

  return [
    ...lines.slice(0, table.startLine),
    headerLine,
    separatorLine,
    ...rowLines,
    ...lines.slice(table.endLine),
  ];
}

/**
 * Updates a specific cell in the first row whose `keyColumn` cell matches
 * `keyValue`. Returns `true` when a row was updated.
 *
 * Used by token-manager to bump the mode-count table without relying on
 * brittle regex patterns that assume specific whitespace.
 */
export function updateCellByKey(
  table: MarkdownTable,
  keyColumn: string,
  keyValue: string,
  targetColumn: string,
  newValue: string
): boolean {
  const keyIndex = table.headers.indexOf(keyColumn);
  const targetIndex = table.headers.indexOf(targetColumn);
  if (keyIndex === -1 || targetIndex === -1) return false;

  for (const row of table.rows) {
    if (row[keyIndex] === keyValue) {
      row[targetIndex] = newValue;
      return true;
    }
  }

  return false;
}
