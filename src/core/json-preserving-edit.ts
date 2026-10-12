// SPDX-License-Identifier: EUPL-1.2
/**
 * Format-preserving rewrites of a JSON document.
 *
 * `fireforge source set`, `fireforge config` and `furnace init` change a
 * few keys of `fireforge.json`. Re-serializing the whole document with
 * `JSON.stringify` expands every compact object and array the project keeps
 * on one line, so a one-key change becomes a diff across unrelated policy
 * sections. This module diffs the document on disk against the wanted one
 * and edits only the values that differ, in place, keeping every other byte
 * (indentation, compact containers, key order, trailing newline).
 *
 * Inserted values follow the style of the container they land in: one line
 * inside a one-line container, the container's own indentation otherwise.
 */

import { applyEdits, findNodeAtLocation, modify, type Node, parseTree } from 'jsonc-parser';

import type { JsonObject, JsonValue } from '../types/json.js';
import { isJsonObject } from '../utils/validation.js';

type JsonPath = (string | number)[];

type DocumentChange =
  | { kind: 'set'; path: JsonPath; value: JsonValue }
  | { kind: 'remove'; path: JsonPath }
  | { kind: 'append'; path: JsonPath; value: JsonValue };

interface DocumentStyle {
  eol: string;
  indentUnit: string;
}

/** The same reviver `readJson` uses, so both sides of the diff agree. */
function parseJsonDocument(text: string): unknown {
  return JSON.parse(text, (key, value: unknown) =>
    key === '__proto__' || key === 'constructor' || key === 'prototype' ? undefined : value
  );
}

function jsonEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  if (!isJsonObject(a) || !isJsonObject(b)) return false;
  const keysA = definedKeys(a);
  const keysB = definedKeys(b);
  return keysA.length === keysB.length && keysA.every((key) => jsonEqual(a[key], b[key]));
}

/** Keys whose value survives `JSON.stringify` (an `undefined` value is an absent key). */
function definedKeys(object: JsonObject): string[] {
  return Object.keys(object).filter((key) => object[key] !== undefined);
}

function collectChanges(
  path: JsonPath,
  before: JsonValue,
  after: JsonValue,
  changes: DocumentChange[]
): void {
  if (jsonEqual(before, after)) return;

  if (isJsonObject(before) && isJsonObject(after)) {
    for (const key of definedKeys(before)) {
      if (after[key] === undefined) changes.push({ kind: 'remove', path: [...path, key] });
    }
    for (const key of definedKeys(after)) {
      const next = after[key] as JsonValue;
      const previous = before[key];
      if (previous === undefined) {
        changes.push({ kind: 'set', path: [...path, key], value: next });
      } else {
        collectChanges([...path, key], previous, next, changes);
      }
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

/** The object or array holding `node` (skipping the property node of an object member). */
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
  if (Array.isArray(value)) {
    return `[${value.map(renderCompact).join(', ')}]`;
  }
  if (isJsonObject(value)) {
    const entries = definedKeys(value).map(
      (key) => `${JSON.stringify(key)}: ${renderCompact(value[key] as JsonValue)}`
    );
    return entries.length === 0 ? '{}' : `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
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

/** Appends `entry` (a property or an array element) after the container's last child. */
function appendEntry(
  text: string,
  container: Node,
  renderEntry: (multiline: boolean, indent: string) => string,
  style: DocumentStyle
): string {
  const children = container.children ?? [];
  const last = children[children.length - 1];
  const containerIndent = lineIndent(text, container.offset);
  if (last === undefined) {
    // Empty container: open it up the way its parent is laid out.
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
  if (root === undefined) {
    throw new Error('document is not valid JSON');
  }

  if (change.kind === 'remove') {
    return applyEdits(text, modify(text, change.path, undefined, {}));
  }

  const target = findNodeAtLocation(root, change.path);
  if (change.kind === 'append') {
    if (target?.type !== 'array') throw new Error('append target is not an array');
    return appendEntry(
      text,
      target,
      (multiline, indent) => renderValue(change.value, multiline, indent, style),
      style
    );
  }

  if (target !== undefined) {
    return replaceNode(text, target, change.value, style);
  }
  const parent = findNodeAtLocation(root, change.path.slice(0, -1));
  const key = change.path[change.path.length - 1];
  if (parent?.type !== 'object' || typeof key !== 'string') {
    throw new Error('insertion parent is not an object');
  }
  return appendEntry(
    text,
    parent,
    (multiline, indent) =>
      `${JSON.stringify(key)}: ${renderValue(change.value, multiline, indent, style)}`,
    style
  );
}

/**
 * Rewrites `text` so it parses to `next`, editing only the values that
 * differ. Returns `undefined` when `text` is not a JSON object or the edit
 * cannot be proven equivalent, so the caller can fall back to a full
 * re-serialization.
 */
export function rewriteJsonPreservingFormat(text: string, next: JsonObject): string | undefined {
  let current: unknown;
  try {
    current = parseJsonDocument(text);
  } catch {
    return undefined;
  }
  if (!isJsonObject(current as JsonValue)) return undefined;

  const changes: DocumentChange[] = [];
  collectChanges([], current as JsonObject, next, changes);
  const style = detectStyle(text);

  try {
    let edited = text;
    for (const change of changes) edited = applyChange(edited, change, style);
    // The edits are structural; prove the result before trusting it.
    return jsonEqual(parseJsonDocument(edited) as JsonValue, next) ? edited : undefined;
  } catch {
    return undefined;
  }
}
