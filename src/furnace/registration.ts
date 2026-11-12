// SPDX-License-Identifier: EUPL-1.2
/**
 * The two engine files a deployed component is registered in.
 *
 * `toolkit/content/jar.mn` packages every module and stylesheet of a custom
 * component as `content/global/elements/<file> (<dir>/<file>)`. Furnace owns
 * the lines whose source lies in a component directory it deploys; it adds
 * the ones a component needs, in tag order among the element lines, and
 * drops the ones no component needs any more. Parsing and placement are
 * `src/mozbuild`'s.
 *
 * `toolkit/content/customElements.js` lists lazily defined elements in
 * arrays iterated by `for (let [tag, script] of …)` loops. An ES module
 * element belongs in the list iterated inside the `DOMContentLoaded`
 * listener (which imports modules); the other lists load subscripts. The
 * file is parsed, never pattern-matched, so a reformatted file still edits
 * correctly, and an entry keeps the layout of its neighbours.
 */
import type * as estree from 'estree';
import MagicString from 'magic-string';

import type { FireForgeError } from '../kernel/errors.js';
import { compareBytes, insertJarEntry, parseJar, updateJarEntries } from '../mozbuild/index.js';
import type { JarFile } from '../register/index.js';
import {
  isStringLiteral,
  lineIndent,
  lineStart,
  parseJs,
  type Positioned,
  walkJs,
} from '../syntax/index.js';
import { CUSTOM_ELEMENTS_JS, ELEMENTS_URL, furnaceError } from './config.js';

/** Element lines sort by the file's stem, so a component's files stay together. */
const tagKey = (target: string): string => target.split('/').pop()?.split('.')[0] ?? target;

/**
 * The jar manifest with exactly the wanted component lines: lines whose
 * source lies in an owned directory and that are not wanted are removed,
 * wanted lines that are missing are added. Everything else is untouched.
 *
 * @param text - jar.mn text
 * @param wanted - The lines the deployed components need
 * @param ownedDirs - Source directories (relative to the manifest) Furnace deploys into
 * @throws `manifest-invalid` when a wanted target is registered with another source
 */
export function planJar(
  text: string,
  wanted: readonly JarFile[],
  ownedDirs: readonly string[]
): string {
  const wantedSources = new Map(wanted.map((file) => [file.target, file.source]));
  const owned = (source: string | undefined): boolean =>
    source !== undefined && ownedDirs.some((dir) => source.startsWith(`${dir}/`));
  let next = updateJarEntries(text, (entry) =>
    owned(entry.source) && wantedSources.get(entry.target) !== entry.source ? null : undefined
  ).text;
  for (const file of [...wanted].sort((a, b) => compareBytes(a.target, b.target))) {
    next = insertJarEntry(next, file, { sortKey: tagKey }).text;
  }
  return next;
}

/**
 * The jar lines of `wanted` that the manifest lacks.
 *
 * @param text - jar.mn text
 * @param wanted - Lines to look for
 */
export function missingJarFiles(text: string, wanted: readonly JarFile[]): JarFile[] {
  const present = new Set(
    parseJar(text).entries.map((entry) => `${entry.target}\0${entry.source}`)
  );
  return wanted.filter((file) => !present.has(`${file.target}\0${file.source}`));
}

/** One `[tag, script]` entry of a registration list. */
export interface ElementEntry {
  tag: string;
  /** Inside the list the `DOMContentLoaded` listener imports as modules. */
  module: boolean;
  start: number;
  end: number;
}

interface RegistrationList {
  array: Positioned<estree.ArrayExpression>;
  module: boolean;
}

function unreadable(cause: unknown): FireForgeError {
  return furnaceError(
    'furnace-custom-elements-unreadable',
    `${CUSTOM_ELEMENTS_JS} does not parse as JavaScript, so its registrations cannot be edited.`,
    { hint: 'Restore the file from upstream and apply again.', cause }
  );
}

function isDomContentLoadedListener(node: estree.Node): boolean {
  if (node.type !== 'CallExpression') return false;
  const { callee, arguments: args } = node;
  const first = args[0];
  return (
    callee.type === 'MemberExpression' &&
    callee.property.type === 'Identifier' &&
    callee.property.name === 'addEventListener' &&
    isStringLiteral(first) &&
    first.value === 'DOMContentLoaded'
  );
}

/** Every registration list: the array of each `for (… of <array or name>)` loop. */
function registrationLists(program: estree.Program): RegistrationList[] {
  const declared = new Map<string, Positioned<estree.ArrayExpression>>();
  walkJs(program, (node) => {
    if (
      node.type === 'VariableDeclarator' &&
      node.id.type === 'Identifier' &&
      node.init?.type === 'ArrayExpression'
    ) {
      declared.set(node.id.name, node.init as Positioned<estree.ArrayExpression>);
    }
  });
  const lists: RegistrationList[] = [];
  walkJs(program, (node, ancestors) => {
    if (node.type !== 'ForOfStatement') return;
    const array =
      node.right.type === 'ArrayExpression'
        ? (node.right as Positioned<estree.ArrayExpression>)
        : node.right.type === 'Identifier'
          ? declared.get(node.right.name)
          : undefined;
    if (array !== undefined) {
      lists.push({ array, module: ancestors.some(isDomContentLoadedListener) });
    }
  });
  return lists;
}

interface ParsedElements {
  lists: RegistrationList[];
  entries: ElementEntry[];
  /** Tags given a creation callback of their own, outside any list. */
  callbacks: Set<string>;
}

function parseElements(text: string): ParsedElements {
  let program: estree.Program;
  try {
    program = parseJs(text, 'script').program;
  } catch (error: unknown) {
    throw unreadable(error);
  }
  const lists = registrationLists(program);
  const entries: ElementEntry[] = [];
  for (const list of lists) {
    for (const element of list.array.elements) {
      const first = element?.type === 'ArrayExpression' ? element.elements[0] : undefined;
      if (!isStringLiteral(first)) continue;
      const { start, end } = element as Positioned<estree.ArrayExpression>;
      entries.push({ tag: first.value, module: list.module, start, end });
    }
  }
  const callbacks = new Set<string>();
  walkJs(program, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'setElementCreationCallback' &&
      isStringLiteral(node.arguments[0])
    ) {
      callbacks.add(node.arguments[0].value);
    }
  });
  return { lists, entries, callbacks };
}

/**
 * The entries of every registration list.
 *
 * @param text - customElements.js text
 * @throws `furnace-custom-elements-unreadable` when the file does not parse
 */
export function elementEntries(text: string): ElementEntry[] {
  return parseElements(text).entries;
}

/**
 * Widens an entry's range to its whole line or lines: the trailing comma,
 * a trailing line comment (the marker) and the line break, and the
 * indentation before it, so removal leaves no hole.
 */
function removalRange(text: string, start: number, end: number): [number, number] {
  let to = end;
  const skipBlanks = (): void => {
    while (text[to] === ' ' || text[to] === '\t') to++;
  };
  skipBlanks();
  if (text[to] === ',') to++;
  skipBlanks();
  if (text.startsWith('//', to)) {
    while (to < text.length && text[to] !== '\n') to++;
  }
  if (text[to] === '\n') to++;
  let from = start;
  while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from--;
  return [from, to];
}

/**
 * customElements.js without the list entries of `tag`. A tag that is not
 * listed changes nothing.
 *
 * @param text - customElements.js text
 * @param tag - The element
 */
export function unregisterElement(text: string, tag: string): string {
  const doomed = parseElements(text).entries.filter((entry) => entry.tag === tag);
  if (doomed.length === 0) return text;
  const edit = new MagicString(text);
  for (const entry of doomed) {
    const [from, to] = removalRange(text, entry.start, entry.end);
    edit.remove(from, to);
  }
  return edit.toString();
}

function entryText(
  text: string,
  reference: ElementEntry | undefined,
  tag: string,
  marker: string
): string {
  const script = `${ELEMENTS_URL}${tag}.mjs`;
  const suffix = `  // ${marker}:`;
  if (reference === undefined)
    return `      [${JSON.stringify(tag)}, ${JSON.stringify(script)}],${suffix}`;
  const indent = lineIndent(text, reference.start);
  if (!text.slice(reference.start, reference.end).includes('\n')) {
    return `${indent}[${JSON.stringify(tag)}, ${JSON.stringify(script)}],${suffix}`;
  }
  const inner = `${indent}  `;
  return [
    `${indent}[${suffix}`,
    `${inner}${JSON.stringify(tag)},${suffix}`,
    `${inner}${JSON.stringify(script)},${suffix}`,
    `${indent}],${suffix}`,
  ].join('\n');
}

/**
 * customElements.js with `tag` listed as an ES module element
 * (`chrome://global/content/elements/<tag>.mjs`), in tag order, each line
 * ending with the project marker. A tag already in the module list, or with
 * a creation callback of its own, changes nothing; one in a subscript list
 * is moved.
 *
 * @param text - customElements.js text
 * @param tag - The element
 * @param marker - The project marker, such as `MYBROWSER`
 * @throws `furnace-custom-elements-unreadable` when the file does not parse
 *   or has no list inside a `DOMContentLoaded` listener
 */
export function registerElement(text: string, tag: string, marker: string): string {
  const parsed = parseElements(text);
  if (parsed.callbacks.has(tag)) return text;
  if (parsed.entries.some((entry) => entry.tag === tag && entry.module)) return text;
  if (parsed.entries.some((entry) => entry.tag === tag)) {
    return registerElement(unregisterElement(text, tag), tag, marker);
  }
  const list = parsed.lists.find((candidate) => candidate.module);
  if (list === undefined) {
    throw furnaceError(
      'furnace-custom-elements-unreadable',
      `${CUSTOM_ELEMENTS_JS} has no element list iterated inside its DOMContentLoaded listener.`,
      { hint: 'Restore the file from upstream and apply again.' }
    );
  }
  const siblings = parsed.entries.filter(
    (entry) => entry.module && entry.start >= list.array.start && entry.end <= list.array.end
  );
  const next = siblings.find((entry) => compareBytes(entry.tag, tag) > 0);
  const previous = [...siblings].reverse().find((entry) => compareBytes(entry.tag, tag) < 0);
  const line = entryText(text, previous ?? next, tag, marker);
  const edit = new MagicString(text);
  if (next !== undefined) {
    edit.appendLeft(lineStart(text, next.start), `${line}\n`);
  } else if (previous === undefined) {
    edit.appendLeft(text.indexOf('\n', list.array.start) + 1, `${line}\n`);
  } else {
    // The last entry may lack a trailing comma; the new one follows it.
    if (!/^[ \t]*,/.test(text.slice(previous.end))) edit.appendLeft(previous.end, ',');
    edit.appendLeft(removalRange(text, previous.start, previous.end)[1], `${line}\n`);
  }
  return edit.toString();
}
