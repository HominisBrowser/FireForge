// SPDX-License-Identifier: EUPL-1.2
/**
 * `moz.build`: the list assignments (`EXTRA_JS_MODULES += [...]`,
 * `EXTRA_JS_MODULES.ns += [...]`, `FOO["x"] = [...]`) and the edits that keep
 * them valid. moz.build is Python; this reads only list literals of strings
 * at statement level and tells whether each sits inside an `if` block.
 */
import {
  type ManifestReference,
  resolveManifestPath,
  TEST_MANIFEST_VARIABLES,
  type TestFlavor,
} from './paths.js';
import {
  compareInsensitive,
  joinSource,
  type ListItem,
  type ManifestEdit,
  manifestError,
  type Placement,
  scanStringList,
  sortedInsertIndex,
  type SourceLine,
  spliceLines,
  splitSource,
} from './text.js';

/** One `VARIABLE += [...]` or `VARIABLE = [...]` statement. */
export interface MozBuildList {
  /** The assignment target as written: `EXTRA_JS_MODULES.ns`, `FOO["x"]`. */
  variable: string;
  /** The variable without attribute or subscript. */
  name: string;
  operator: '+=' | '=';
  /** The line of the opening bracket. */
  startLine: number;
  /** The line of the closing bracket. */
  endLine: number;
  /** The statement's indentation. */
  indent: string;
  /** Inside an `if`, `elif` or `else` block. */
  conditional: boolean;
  items: ListItem[];
}

/** A parsed moz.build. `lines` covers the whole file, so the parse is lossless. */
export interface MozBuildFile {
  lines: SourceLine[];
  lists: MozBuildList[];
}

const LIST_START = /^(\s*)([A-Z_][A-Z_0-9]*)((?:\.[A-Za-z_]\w*)|(?:\[[^\]]+\]))?\s*(\+=|=)\s*\[/;
const BLOCK_KEYWORD = /^\s*(if|elif|else|for|with|while|try|except|finally|def|class)\b/;

/** A line without its trailing `#` comment; strings are not modelled, which moz.build headers do not need. */
function code(line: string): string {
  return line.replace(/#.*$/, '').trimEnd();
}

/**
 * The last line of a block header starting at `index`: the line where the
 * brackets opened on the header close and the text ends with `:`, so
 * `if (\n    a\n    and b\n):` is one header. Undefined when no such line
 * follows (the keyword starts no block).
 */
function headerEnd(lines: readonly SourceLine[], index: number): number | undefined {
  let depth = 0;
  for (let at = index; at < lines.length; at++) {
    const text = code(lines[at]?.text ?? '');
    for (const char of text) {
      if ('([{'.includes(char)) depth++;
      else if (')]}'.includes(char)) depth--;
    }
    if (depth <= 0) return text.endsWith(':') ? at : undefined;
  }
  return undefined;
}

/**
 * Parses a moz.build. Never throws: statements it does not recognise are
 * skipped, so partial text (the added lines of a diff) parses as well. A
 * list is conditional inside an `if`/`elif`/`else` block, and whenever it is
 * indented: an indented statement belongs to some block, and an edit must
 * not treat a list a block may skip as the file's own.
 *
 * @param text - moz.build text
 */
export function parseMozBuild(text: string): MozBuildFile {
  const lines = splitSource(text);
  const lists: MozBuildList[] = [];
  const blocks: { indent: number; conditional: boolean }[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]?.text ?? '';
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    while ((blocks.at(-1)?.indent ?? -1) >= indent) blocks.pop();
    const start = LIST_START.exec(line);
    if (start !== null) {
      const scan = scanStringList(lines, index, start[0].length);
      if (scan !== undefined) {
        lists.push({
          variable: (start[2] ?? '') + (start[3] ?? ''),
          name: start[2] ?? '',
          operator: start[4] === '=' ? '=' : '+=',
          startLine: index,
          endLine: scan.endLine,
          indent: start[1] ?? '',
          conditional: indent > 0 || blocks.some((block) => block.conditional),
          items: scan.items,
        });
        index = scan.endLine;
      }
      continue;
    }
    const keyword = BLOCK_KEYWORD.exec(line)?.[1];
    const end = keyword === undefined ? undefined : headerEnd(lines, index);
    if (keyword !== undefined && end !== undefined) {
      blocks.push({ indent, conditional: ['if', 'elif', 'else'].includes(keyword) });
      index = end;
    }
  }
  return { lines, lists };
}

/** Which of several lists of one variable an operation uses. */
export interface MozBuildListSelector {
  /** Also consider lists inside `if` blocks (default: unconditional lists only). */
  conditional?: boolean;
  /** Use the list whose opening bracket is on this line. */
  line?: number;
}

/**
 * The lists assigned to `variable` (exactly as written, so
 * `EXTRA_JS_MODULES.ns` is not `EXTRA_JS_MODULES`).
 *
 * @param text - moz.build text
 * @param variable - Assignment target
 * @param selector - Which lists count
 */
export function findMozBuildLists(
  text: string,
  variable: string,
  selector: MozBuildListSelector = {}
): MozBuildList[] {
  return selectLists(parseMozBuild(text), variable, selector);
}

/** How {@link addToMozBuildList} treats a missing list. */
export interface MozBuildAddOptions extends MozBuildListSelector {
  /** Append a new `variable += [...]` statement when no list exists (default: refuse). */
  create?: boolean;
}

function selectLists(
  file: MozBuildFile,
  variable: string,
  selector: MozBuildListSelector
): MozBuildList[] {
  return file.lists.filter(
    (list) =>
      list.variable === variable &&
      (selector.line === undefined
        ? selector.conditional === true || !list.conditional
        : list.startLine === selector.line)
  );
}

function single(
  file: MozBuildFile,
  variable: string,
  selector: MozBuildListSelector
): MozBuildList | undefined {
  const matches = selectLists(file, variable, selector);
  if (matches.length > 1) {
    throw manifestError(
      `${variable} is assigned in several places.`,
      'Select one list with the line option.'
    );
  }
  return matches[0];
}

function quoted(value: string, quote: string): string {
  return `${quote}${value}${quote}`;
}

/** Comment lines directly above `line` belong to the item on it. */
function blockStart(lines: readonly SourceLine[], line: number, floor: number): number {
  let start = line;
  while (start - 1 > floor && (lines[start - 1]?.text ?? '').trimStart().startsWith('#')) start--;
  return start;
}

/** Rewrites a one-line list as the multi-line shape, with its items on their own lines. */
function expandList(file: MozBuildFile, list: MozBuildList, extra: string): SourceLine[] {
  const text = file.lines[list.startLine]?.text ?? '';
  const quote = list.items[0]?.quote ?? '"';
  const open = text.slice(0, LIST_START.exec(text)?.[0].length ?? 0);
  const close = text.slice(text.lastIndexOf(']'));
  const itemIndent = `${list.indent}    `;
  const values = list.items.map((item) => item.value);
  const sorted = values.every(
    (value, i) => i === 0 || compareInsensitive(values[i - 1] ?? '', value) <= 0
  );
  const all = [...values];
  all.splice(sorted ? sortedInsertIndex(values, extra) : values.length, 0, extra);
  const body = all.map((value) => `${itemIndent}${quoted(value, quote)},`);
  return spliceLines(file.lines, list.startLine, 1, [open, ...body, `${list.indent}${close}`]);
}

/**
 * Adds `value` to a list of `variable`, in sort order when the list is
 * sorted (case-insensitively, as mozbuild checks) and last when it is not.
 * A one-line list becomes a multi-line one. An item already present changes
 * nothing; two candidate lists, or none without `create`, are refused.
 *
 * @param text - moz.build text
 * @param variable - Assignment target
 * @param value - The string to add
 * @param options - Which list, and whether to create one
 */
export function addToMozBuildList(
  text: string,
  variable: string,
  value: string,
  options: MozBuildAddOptions = {}
): Placement {
  const file = parseMozBuild(text);
  const list = single(file, variable, options);
  if (list === undefined) {
    if (options.create !== true) throw manifestError(`No list assigned to ${variable} was found.`);
    return appendList(file, variable, value);
  }
  const present = list.items.find((item) => item.value === value);
  if (present !== undefined) return { text, changed: false, line: present.line };
  if (list.startLine === list.endLine) {
    return {
      text: joinSource(expandList(file, list, value)),
      changed: true,
      line: list.startLine + 1,
    };
  }
  return insertItemLine(file, list, value);
}

/** Adds a new `variable += [...]` statement at the end of the file. */
function appendList(file: MozBuildFile, variable: string, value: string): Placement {
  const kept = [...file.lines];
  while (kept.length > 0 && (kept.at(-1)?.text ?? '').trim() === '') kept.pop();
  const block = [...(kept.length > 0 ? [''] : []), `${variable} += [`, `    "${value}",`, ']'];
  return {
    text: joinSource(spliceLines(kept, kept.length, 0, block)),
    changed: true,
    line: kept.length + (kept.length > 0 ? 1 : 0),
  };
}

/** Puts a new item on its own line of a multi-line list, copying a neighbour's indentation and quotes. */
function insertItemLine(file: MozBuildFile, list: MozBuildList, value: string): Placement {
  const slots = list.items.filter((item) => item.ownLine);
  const index = sortedInsertIndex(
    slots.map((slot) => slot.value),
    value
  );
  const next = slots[index];
  const previous = slots[index - 1];
  const at =
    next === undefined
      ? (previous?.line ?? list.startLine) + 1
      : blockStart(file.lines, next.line, previous?.line ?? list.startLine);
  const neighbour = previous ?? next;
  const indent =
    neighbour === undefined
      ? `${list.indent}    `
      : (file.lines[neighbour.line]?.text.slice(0, neighbour.start) ?? '');
  let lines = [...file.lines];
  const before = previous === undefined ? undefined : lines[previous.line];
  if (previous !== undefined && before !== undefined) {
    if (!before.text.slice(previous.end).trimStart().startsWith(',')) {
      const text = `${before.text.slice(0, previous.end)},${before.text.slice(previous.end)}`;
      lines[previous.line] = { ...before, text };
    }
  }
  lines = spliceLines(lines, at, 0, [`${indent}${quoted(value, neighbour?.quote ?? '"')},`]);
  const result: Placement = { text: joinSource(lines), changed: true, line: at };
  if (before !== undefined) result.previous = before.text.trim();
  return result;
}

/**
 * Removes `value` from a list of `variable`. An item alone on its line takes
 * the line with it; one sharing a line takes only itself and a neighbouring
 * comma.
 *
 * @param text - moz.build text
 * @param variable - Assignment target
 * @param value - The string to remove
 * @param selector - Which list
 */
export function removeFromMozBuildList(
  text: string,
  variable: string,
  value: string,
  selector: MozBuildListSelector = {}
): ManifestEdit {
  const file = parseMozBuild(text);
  const list = single(file, variable, selector);
  const item = list?.items.find((candidate) => candidate.value === value);
  if (item === undefined) return { text, changed: false };
  if (item.ownLine && (list?.startLine ?? item.line) !== item.line) {
    return { text: joinSource(spliceLines(file.lines, item.line, 1, [])), changed: true };
  }
  const line = file.lines[item.line];
  if (line === undefined) return { text, changed: false };
  const after = /^\s*,\s*/.exec(line.text.slice(item.end));
  const before = /,\s*$/.exec(line.text.slice(0, item.start));
  const from = after === null && before !== null ? item.start - before[0].length : item.start;
  const to = item.end + (after?.[0].length ?? 0);
  const lines = [...file.lines];
  lines[item.line] = { ...line, text: line.text.slice(0, from) + line.text.slice(to) };
  return { text: joinSource(lines), changed: true };
}

/**
 * The paths a moz.build lists, resolved against its directory. Only list
 * items count; strings elsewhere (conditions, `with Files("...")`) are not
 * paths the build reads.
 *
 * @param manifestPath - Engine-relative path of the moz.build
 * @param text - moz.build text
 */
export function mozBuildReferences(manifestPath: string, text: string): ManifestReference[] {
  const file = parseMozBuild(text);
  const references: ManifestReference[] = [];
  for (const list of file.lists) {
    for (const item of list.items) {
      if (!item.value.includes('.') && !item.value.includes('/')) continue;
      const matcher = resolveManifestPath(manifestPath, item.value);
      if (matcher === undefined) continue;
      references.push({
        kind: 'list-item',
        token: item.value,
        line: item.line,
        text: (file.lines[item.line]?.text ?? '').trim(),
        matcher,
      });
    }
  }
  return references;
}

/** A test manifest a moz.build lists. */
export interface ListedTestManifest {
  /** Engine-relative path of the manifest. */
  path: string;
  flavor: TestFlavor;
  /** The list variable, such as `BROWSER_CHROME_MANIFESTS`. */
  variable: string;
  /** The item as written, relative to the moz.build. */
  value: string;
}

/**
 * The test manifests a moz.build lists in its `*_MANIFESTS` variables, with
 * the flavour each variable declares. Conditional lists count: the manifest
 * is a test manifest whether or not this build runs it.
 *
 * @param manifestPath - Engine-relative path of the moz.build
 * @param text - moz.build text
 */
export function mozBuildTestManifests(manifestPath: string, text: string): ListedTestManifest[] {
  const listed: ListedTestManifest[] = [];
  for (const list of parseMozBuild(text).lists) {
    const flavor = TEST_MANIFEST_VARIABLES[list.name];
    if (flavor === undefined) continue;
    for (const item of list.items) {
      const path = resolveManifestPath(manifestPath, item.value)?.exact;
      if (path !== undefined) listed.push({ path, flavor, variable: list.name, value: item.value });
    }
  }
  return listed;
}

/**
 * Variables mozbuild declares as strict-ordering lists: configure refuses an
 * out-of-order append. `DIRS` is not among them, since directory order
 * matters. A dotted namespace inherits its variable's rule.
 */
const STRICT_ORDERED = new Set([
  'EXTRA_COMPONENTS',
  'EXTRA_JS_MODULES',
  'EXTRA_PP_COMPONENTS',
  'EXPORTS',
  'PYTHON_UNITTEST_MANIFESTS',
  'TESTING_JS_MODULES',
  'XPIDL_SOURCES',
]);

/** Where a strict-ordering list first leaves sorted order. */
export interface SortViolation {
  variable: string;
  line: number;
  /** The item mozbuild expects at that position. */
  expected: string;
  /** The item found there. */
  got: string;
}

/**
 * The strict-ordering lists of a moz.build that are not sorted, with the
 * first out-of-place item of each, as mozbuild reports them at configure time.
 *
 * @param text - moz.build text
 */
export function mozBuildSortViolations(text: string): SortViolation[] {
  const violations: SortViolation[] = [];
  for (const list of parseMozBuild(text).lists) {
    if (!STRICT_ORDERED.has(list.name)) continue;
    const values = list.items.map((item) => item.value);
    const sorted = [...values].sort(compareInsensitive);
    const at = values.findIndex((value, i) => value !== sorted[i]);
    if (at === -1) continue;
    violations.push({
      variable: list.variable,
      line: list.items[at]?.line ?? list.startLine,
      expected: sorted[at] ?? '',
      got: values[at] ?? '',
    });
  }
  return violations;
}
