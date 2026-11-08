// SPDX-License-Identifier: EUPL-1.2
/**
 * The one description of a `ps` listing: which binary, which environment,
 * which arguments, and how a row is read back. Pure, so every caller shares
 * one parser and fixtures need no process. {@link listProcesses} in
 * `process-list.ts` runs it for diagnostics; `process-birth.ts` runs it for
 * ownership decisions.
 */

/** Columns FireForge reads. `args` and `command` take the rest of the line. */
export type ProcessColumn =
  'pid' | 'ppid' | 'pgid' | 'stat' | 'etime' | 'time' | 'lstart' | 'args' | 'command';

type NumericColumn = 'pid' | 'ppid' | 'pgid';

/** A parsed row with exactly the requested columns. `lstart` is epoch seconds, as a string. */
export type ProcessRow<C extends ProcessColumn> = {
  [K in C]: K extends NumericColumn ? number : string;
};

/**
 * A planted `ps` earlier on PATH must not decide who gets signalled, so the
 * absolute path is used where it is guaranteed. Linux distributions disagree
 * on the location; ownership there reads procfs and never runs this binary.
 */
export const PS_BINARY = process.platform === 'darwin' ? '/bin/ps' : 'ps';

/**
 * `LC_ALL=C` keeps `lstart` in the one format {@link parseLstart} reads: other
 * locales print `Sa.  7 Nov.`. `TZ=UTC` keeps a recorded birth comparable
 * across a daylight-saving change or a changed zone, since `lstart` renders in
 * local time.
 */
export const PS_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', TZ: 'UTC' };

/**
 * Arguments for a listing of every process, or of `pids` only.
 *
 * @param columns - Columns in output order; a rest-of-line column must be last
 * @param pids - Limit the listing to these pids
 */
export function psArguments(
  columns: readonly ProcessColumn[],
  pids?: readonly number[]
): readonly string[] {
  const format = columns.map((column) => `${column}=`).join(',');
  return pids === undefined ? ['-axo', format] : ['-o', format, '-p', pids.join(',')];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Reads the five `lstart` tokens (`Sat Nov  7 01:53:10 2026`, UTC under
 * {@link PS_ENV}) as epoch seconds.
 *
 * @param tokens - `[weekday, month, day, hh:mm:ss, year]`
 * @returns Epoch seconds as a string, or undefined when the tokens are not a date
 */
function parseLstart(tokens: readonly string[]): string | undefined {
  const [, month, day, clock, year] = tokens;
  const time = /^(\d{2}):(\d{2}):(\d{2})$/.exec(clock ?? '');
  const monthIndex = MONTHS.indexOf(month ?? '');
  if (!time || monthIndex < 0 || !/^\d+$/.test(day ?? '') || !/^\d{4}$/.test(year ?? '')) {
    return undefined;
  }
  const ms = Date.UTC(
    Number(year),
    monthIndex,
    Number(day),
    Number(time[1]),
    Number(time[2]),
    Number(time[3])
  );
  return Number.isNaN(ms) ? undefined : String(ms / 1000);
}

/**
 * Reads one row, consuming whitespace-separated tokens per column.
 *
 * @returns Column values, or undefined when the line does not fit the columns
 */
function parseRow(
  line: string,
  columns: readonly ProcessColumn[]
): Partial<Record<ProcessColumn, number | string>> | undefined {
  const tokenizer = /\S+/g;
  const row: Partial<Record<ProcessColumn, number | string>> = {};
  const next = (): string | undefined => tokenizer.exec(line)?.[0];
  for (const column of columns) {
    if (column === 'args' || column === 'command') {
      const rest = line.slice(tokenizer.lastIndex).trim();
      if (rest.length === 0) return undefined;
      row[column] = rest;
      return row;
    }
    if (column === 'lstart') {
      const start = parseLstart([
        next() ?? '',
        next() ?? '',
        next() ?? '',
        next() ?? '',
        next() ?? '',
      ]);
      if (start === undefined) return undefined;
      row[column] = start;
      continue;
    }
    const token = next();
    if (token === undefined) return undefined;
    if (column === 'pid' || column === 'ppid' || column === 'pgid') {
      if (!/^\d+$/.test(token)) return undefined;
      row[column] = Number(token);
    } else {
      row[column] = token;
    }
  }
  return row;
}

/**
 * Parses a listing. A line that does not fit the columns is skipped: `ps`
 * prints no header for `col=` formats, so only damage produces one, and a
 * caller that must not lose a row compares against {@link countListingLines}.
 *
 * @param text - Raw `ps` output (CRLF tolerated)
 * @param columns - The columns the listing was asked for
 */
export function parseProcessListing<C extends ProcessColumn>(
  text: string,
  columns: readonly C[]
): ProcessRow<C>[] {
  const rows: ProcessRow<C>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const row = parseRow(line, columns);
    if (row !== undefined) rows.push(row as ProcessRow<C>);
  }
  return rows;
}

/** Number of non-blank lines in a listing. */
export function countListingLines(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

/**
 * Whether `command` names `root` as a whole absolute path token, or a path
 * under it. A generic `obj-*` segment, `<root>2` and `/sibling<root>` do not
 * count. A relative or empty root never matches, so an unknown root grants
 * nothing.
 *
 * @param command - A process command line
 * @param root - Absolute directory
 */
export function commandNamesRoot(command: string, root: string | undefined): boolean {
  if (!root || !/^(?:\/|[A-Za-z]:[/\\])/.test(root)) return false;
  const needle = root.replace(/[/\\]+$/, '');
  for (
    let at = command.indexOf(needle);
    at !== -1;
    at = command.indexOf(needle, at + needle.length)
  ) {
    const before = at === 0 ? ' ' : (command[at - 1] ?? ' ');
    const after = command[at + needle.length] ?? ' ';
    if (/[\s"'=]/.test(before) && /[\s"'/\\]/.test(after)) return true;
  }
  return false;
}
