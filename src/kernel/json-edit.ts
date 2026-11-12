// SPDX-License-Identifier: EUPL-1.2
/**
 * Format-preserving edits of a JSON document. Re-serialising a whole document
 * expands every one-line object and array a project keeps compact, so a
 * one-key change becomes a diff across unrelated sections. {@link editJsonText}
 * compares the text on disk with the wanted document and rewrites only the
 * values that differ, keeping every other byte: indentation, one-line
 * containers, key order, line endings and the trailing newline.
 *
 * An inserted value follows the container it lands in: one line inside a
 * one-line container, the container's own indentation otherwise.
 */
import { applyEdits, findNodeAtLocation, modify, type Node, parseTree } from 'jsonc-parser';

import { isRecord, type JsonObject, type JsonValue, parseJson } from './json.js';

type JsonPath = (string | number)[];

type DocumentChange =
  | { kind: 'set'; path: JsonPath; value: JsonValue }
  | { kind: 'remove'; path: JsonPath }
  | { kind: 'append'; path: JsonPath; value: JsonValue };

interface DocumentStyle {
  eol: string;
  indentUnit: string;
}

/** Keys whose value survives serialisation: an `undefined` value is an absent key. */
function definedKeys(object: JsonObject): string[] {
  return Object.keys(object).filter((key) => object[key] !== undefined);
}

function asObject(value: JsonValue | undefined): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  const left = asObject(a);
  const right = asObject(b);
  if (left === undefined || right === undefined) return false;
  const keys = definedKeys(left);
  return (
    keys.length === definedKeys(right).length &&
    keys.every((key) => jsonEqual(left[key], right[key]))
  );
}

function collectChanges(
  path: JsonPath,
  before: JsonValue,
  after: JsonValue,
  changes: DocumentChange[]
): void {
  if (jsonEqual(before, after)) return;
  const beforeObject = asObject(before);
  const afterObject = asObject(after);
  if (beforeObject !== undefined && afterObject !== undefined) {
    for (const key of definedKeys(beforeObject)) {
      if (afterObject[key] === undefined) changes.push({ kind: 'remove', path: [...path, key] });
    }
    for (const key of definedKeys(afterObject)) {
      const next = afterObject[key] as JsonValue;
      const previous = beforeObject[key];
      if (previous === undefined) changes.push({ kind: 'set', path: [...path, key], value: next });
      else collectChanges([...path, key], previous, next, changes);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const isAppend =
      after.length > before.length &&
      before.every((value, index) => jsonEqual(value, after[index]));
    if (isAppend) {
      for (const value of after.slice(before.length)) changes.push({ kind: 'append', path, value });
      return;
    }
    if (after.length === before.length) {
      before.forEach((value, index) => {
        collectChanges([...path, index], value, after[index] as JsonValue, changes);
      });
      return;
    }
  }
  changes.push({ kind: 'set', path, value: after });
}

function detectStyle(text: string): DocumentStyle {
  const indent = /^([ \t]+)\S/m.exec(text)?.[1];
  return {
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    indentUnit: indent === undefined ? '  ' : indent.startsWith('\t') ? '\t' : indent,
  };
}

function isMultiline(text: string, node: Node | undefined): boolean {
  return node !== undefined && text.slice(node.offset, node.offset + node.length).includes('\n');
}

/** The object or array holding `node`, skipping the property node of an object member. */
function containerOf(node: Node): Node | undefined {
  const parent = node.parent;
  return parent?.type === 'property' ? parent.parent : parent;
}

/** Leading whitespace of the line `offset` sits on. */
function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart))?.[0] ?? '';
}

function renderCompact(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(renderCompact).join(', ')}]`;
  const object = asObject(value);
  if (object === undefined) return JSON.stringify(value);
  const entries = definedKeys(object).map(
    (key) => `${JSON.stringify(key)}: ${renderCompact(object[key] as JsonValue)}`
  );
  return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
}

function renderValue(
  value: JsonValue,
  multiline: boolean,
  indent: string,
  style: DocumentStyle
): string {
  if (!multiline) return renderCompact(value);
  return JSON.stringify(value, null, style.indentUnit)
    .split('\n')
    .join(style.eol + indent);
}

function replaceRange(text: string, offset: number, length: number, content: string): string {
  return text.slice(0, offset) + content + text.slice(offset + length);
}

/** Replaces an existing value, keeping a container's one-line or multi-line shape. */
function replaceNode(text: string, node: Node, value: JsonValue, style: DocumentStyle): string {
  const isContainer = node.type === 'object' || node.type === 'array';
  const multiline = isContainer ? isMultiline(text, node) : isMultiline(text, containerOf(node));
  const rendered = renderValue(value, multiline, lineIndent(text, node.offset), style);
  return replaceRange(text, node.offset, node.length, rendered);
}

/** Appends an entry (a property or an array element) after the container's last child. */
function appendEntry(
  text: string,
  container: Node,
  renderEntry: (multiline: boolean, indent: string) => string,
  style: DocumentStyle
): string {
  const last = container.children?.at(-1);
  const containerIndent = lineIndent(text, container.offset);
  if (last === undefined) {
    // An empty container opens up the way its parent is laid out.
    const multiline = isMultiline(text, containerOf(container));
    const [open, close] = container.type === 'array' ? ['[', ']'] : ['{', '}'];
    const childIndent = containerIndent + style.indentUnit;
    const body = multiline
      ? `${open}${style.eol}${childIndent}${renderEntry(true, childIndent)}${style.eol}${containerIndent}${close}`
      : container.type === 'array'
        ? `${open}${renderEntry(false, childIndent)}${close}`
        : `${open} ${renderEntry(false, childIndent)} ${close}`;
    return replaceRange(text, container.offset, container.length, body);
  }
  const multiline = isMultiline(text, container);
  const indent = multiline ? lineIndent(text, last.offset) : containerIndent;
  const separator = multiline ? `,${style.eol}${indent}` : ', ';
  return replaceRange(
    text,
    last.offset + last.length,
    0,
    separator + renderEntry(multiline, indent)
  );
}

function applyChange(text: string, change: DocumentChange, style: DocumentStyle): string {
  const root = parseTree(text);
  if (root === undefined) throw new Error('document is not valid JSON');
  if (change.kind === 'remove') return applyEdits(text, modify(text, change.path, undefined, {}));
  const target = findNodeAtLocation(root, change.path);
  if (change.kind === 'append') {
    if (target?.type !== 'array') throw new Error('append target is not an array');
    const render = (multiline: boolean, indent: string): string =>
      renderValue(change.value, multiline, indent, style);
    return appendEntry(text, target, render, style);
  }
  if (target !== undefined) return replaceNode(text, target, change.value, style);
  const parent = findNodeAtLocation(root, change.path.slice(0, -1));
  const key = change.path.at(-1);
  if (parent?.type !== 'object' || typeof key !== 'string') {
    throw new Error('insertion parent is not an object');
  }
  const render = (multiline: boolean, indent: string): string =>
    `${JSON.stringify(key)}: ${renderValue(change.value, multiline, indent, style)}`;
  return appendEntry(text, parent, render, style);
}

/**
 * Rewrites JSON text so it parses to `next`, editing only the values that
 * differ. Returns undefined when the text is not a JSON object or the edit
 * cannot be proven to produce `next`, so the caller can write the document
 * in full instead.
 *
 * @param text - The document as it is on disk
 * @param next - The document wanted
 */
export function editJsonText(text: string, next: JsonObject): string | undefined {
  let current: JsonValue;
  try {
    current = parseJson(text);
  } catch {
    return undefined;
  }
  const currentObject = asObject(current);
  if (currentObject === undefined) return undefined;
  const changes: DocumentChange[] = [];
  collectChanges([], currentObject, next, changes);
  const style = detectStyle(text);
  try {
    let edited = text;
    for (const change of changes) edited = applyChange(edited, change, style);
    // The edits are structural; prove the result before trusting it.
    return jsonEqual(parseJson(edited), next) ? edited : undefined;
  } catch {
    return undefined;
  }
}
