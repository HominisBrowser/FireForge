// SPDX-License-Identifier: EUPL-1.2
/**
 * Attribute-variant block helpers for the tokens CSS scaffold.
 *
 * `fireforge token add --mode` can author the base `:root { }` block and the
 * dark `@media (prefers-color-scheme: dark)` block, but not an
 * attribute-keyed selector such as `:root[data-skin="precision"]` or
 * `:root[data-private]`, which would otherwise have to be hand-edited. These
 * helpers locate (or compute the insertion point for) a top-level
 * `:root<variant>` block so `token-manager.ts` can splice a declaration into
 * it, keeping all token authoring in the CLI.
 */

import { escapeRegex } from '../utils/regex.js';
import type { TokenDeclarationLocation } from './token-category.js';
import {
  findBlockCloseIndex,
  isolateBlockClose,
  stripBlockCommentsInLines,
} from './token-dark-mode.js';

/**
 * Outcome of {@link validateVariantSelector}. `ok: true` carries the
 * normalized (quoted) selector fragment. `ok: false` carries a
 * human-readable reason suitable for throwing as an `InvalidArgumentError`.
 */
export type VariantValidation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * One attribute selector fragment: `[data-private]` (boolean attribute) or
 * `[data-skin=precision]` / `[data-skin="precision"]` (attribute with
 * value). The name and value halves are restricted to identifier-safe
 * characters so the fragment can be spliced into CSS verbatim without
 * escaping concerns.
 *
 * A multi-fragment variant is checked one group at a time (see
 * {@link splitAttributeGroups}) rather than by wrapping this in a `+`: the
 * repeated form is the shape CodeQL flags as `js/polynomial-redos`, and the
 * split the matcher already performs is available for free.
 */
const ATTRIBUTE_FRAGMENT_PATTERN =
  /^\[[a-zA-Z][a-zA-Z0-9_-]*(?:=(?:"[a-zA-Z0-9_-]+"|'[a-zA-Z0-9_-]+'|[a-zA-Z0-9_-]+))?\]$/;

/**
 * A pseudo-class tail: `:not(…)`, `:hover`, and friends. The parenthesised
 * argument is captured rather than validated here. It is a fragment run of
 * its own and goes through the same per-group check.
 */
const QUALIFIER_PATTERN = /^:[a-zA-Z][a-zA-Z0-9-]*(?:\(([^()]*)\))?$/;

/**
 * Splits a run of consecutive attribute fragments into its groups, or
 * returns `undefined` when the run is not exactly that: a group that does
 * not open with `[`, an unclosed group, an empty run, or a group whose name
 * or value is not identifier-safe.
 *
 * @param run - The `[…][…]` text with no `:root` prefix
 * @returns The individual fragments, or undefined when the run is not valid
 */
function splitAttributeGroups(run: string): string[] | undefined {
  const groups: string[] = [];
  let cursor = 0;
  while (cursor < run.length) {
    if (run[cursor] !== '[') return undefined;
    const close = run.indexOf(']', cursor);
    if (close === -1) return undefined;
    const group = run.slice(cursor, close + 1);
    if (!ATTRIBUTE_FRAGMENT_PATTERN.test(group)) return undefined;
    groups.push(group);
    cursor = close + 1;
  }
  return groups.length > 0 ? groups : undefined;
}

/** Rewrites `=value` / `='value'` to the double-quoted Mozilla convention. */
function normalizeAttributeFragment(group: string): string {
  return group
    .replace(/='([a-zA-Z0-9_-]+)'\]$/, '="$1"]')
    .replace(/=([a-zA-Z0-9_-]+)\]$/, '="$1"]');
}

/**
 * Validates a `--variant` selector fragment and normalizes any `=value`
 * form to the double-quoted `="value"` shape (Mozilla convention).
 * Boolean-attribute fragments are returned unchanged.
 *
 * Structure is decided by {@link rootAttributeSelector}, the matcher's own
 * parse, rather than by a second regex. The matcher consumes consecutive
 * `[…]` groups and stops at a pseudo-class tail, and a separate validator
 * that does not follow it leaves blocks such as
 * `:root[data-skin="humanist"]:not([data-private])` findable but
 * unnameable. Running both halves off one parse keeps them from drifting
 * apart. Character-level safety stays a
 * separate, per-group check, because the matcher finds bracket boundaries
 * and validates no characters at all.
 *
 * @param raw - Raw `--variant` value from the CLI / programmatic caller.
 */
export function validateVariantSelector(raw: unknown): VariantValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'must be a string when set' };
  }
  const reject = {
    ok: false,
    reason:
      'must be one or more attribute selectors like [data-private], [data-skin=precision] ' +
      'or [data-skin=precision][data-theme=dark], optionally followed by a pseudo-class ' +
      'such as :not([data-private]) (identifier-safe attribute names and values only)',
  } as const;

  const value = raw.trim();
  if (value === '') return reject;
  const parts = rootAttributeSelector(`:root${value} {`);
  // The parse must have consumed the whole fragment: anything it declined to
  // read (a stray space, a trailing combinator) is text the matcher would
  // not see either, so accepting it would author a block nothing can find.
  if (parts === undefined || `${parts.attributes}${parts.qualifier}` !== `:root${value}`)
    return reject;

  const groups = splitAttributeGroups(parts.attributes.slice(':root'.length));
  if (groups === undefined) return reject;

  let qualifier = '';
  if (parts.qualifier !== '') {
    const match = QUALIFIER_PATTERN.exec(parts.qualifier);
    if (match === null) return reject;
    const inner = match[1];
    if (inner === undefined) {
      qualifier = parts.qualifier;
    } else {
      const innerGroups = splitAttributeGroups(inner);
      if (innerGroups === undefined) return reject;
      const name = parts.qualifier.slice(0, parts.qualifier.indexOf('('));
      qualifier = `${name}(${innerGroups.map(normalizeAttributeFragment).join('')})`;
    }
  }

  return { ok: true, value: `${groups.map(normalizeAttributeFragment).join('')}${qualifier}` };
}

/**
 * Reduces a `:root<attr>` selector to a quote- and whitespace-insensitive
 * canonical form so `[data-skin="precision"]`, `[data-skin='precision']`,
 * and `[data-skin=precision]` all compare equal when matching an existing
 * block against the requested variant.
 */
function canonicalSelector(selector: string): string {
  return selector.replace(/\s+/g, '').replace(/["']/g, '');
}

/**
 * A `:root[…]` selector split at the end of its attribute run.
 */
interface RootSelectorParts {
  /** `:root` plus every consecutive `[…]` group that directly follows it. */
  attributes: string;
  /**
   * Whatever sits between the attribute run and the block's `{`: a
   * pseudo-class qualifier such as `:not([data-private])`, or `''`.
   */
  qualifier: string;
}

/**
 * Splits the `:root[…]` selector on `line` into its attribute run and any
 * trailing qualifier, or `undefined` when the line carries none.
 *
 * Index arithmetic rather than `/:root\[[^{]*\]/`: `[^{]` also matches `]`,
 * so that pattern backtracks quadratically on a line repeating `:root[`
 * (CodeQL `js/polynomial-redos`). This walk is linear and allocation-free
 * per group.
 *
 * It consumes consecutive `[…]` groups and stops at the first character that
 * is not `[`, so a multi-attribute selector compares as a whole and a
 * pseudo-class tail such as `:not([data-private])` is the qualifier rather
 * than part of the attribute run. A qualified block
 * (`:root[data-theme="light"]:not([data-private]) {`) and its unqualified
 * sibling therefore both match, which keeps a themed override from landing
 * in one block and skipping the other.
 */
function rootAttributeSelector(line: string): RootSelectorParts | undefined {
  const start = line.indexOf(':root[');
  if (start === -1 || line.slice(0, start).trim() !== '') return undefined;
  const brace = line.indexOf('{', start);
  const limit = brace === -1 ? line.length : brace;

  let cursor = start + ':root'.length;
  let end = cursor;
  while (cursor < limit && line[cursor] === '[') {
    const close = line.indexOf(']', cursor);
    if (close === -1 || close >= limit) break;
    cursor = close + 1;
    end = cursor;
  }
  if (end === start + ':root'.length) return undefined;

  return { attributes: line.slice(start, end), qualifier: line.slice(end, limit).trim() };
}

/**
 * A located `:root<variant>` block: `open`/`close` are line indices,
 * `qualifier` is the pseudo-class tail the selector carried (`''` when
 * unqualified).
 */
interface VariantBlock {
  open: number;
  close: number;
  qualifier: string;
}

/** Blank quoted values for structural brace and declaration scans. */
function structureLines(lines: string[]): string[] {
  return lines.map((line) =>
    line.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (match) => ' '.repeat(match.length))
  );
}

/** Count structural braces in an already masked line. */
function braceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) delta += ch === '{' ? 1 : ch === '}' ? -1 : 0;
  return delta;
}

/**
 * Finds the top-level `:root<variant>` block whose attribute selector
 * matches `variant` (compared canonically). Returns the opening-brace and
 * closing-brace line indices, or `undefined` when no such block exists.
 *
 * Scans a comment-stripped mirror of `lines` so braces inside comments do
 * not offset the depth counter. The returned indices line up with the
 * original array.
 */
function findVariantBlock(
  lines: string[],
  variant: string,
  anyQualifier = false
): VariantBlock | undefined {
  const stripped = stripBlockCommentsInLines(lines);
  const structure = structureLines(stripped);
  // The request goes through the same parse as the candidate lines, so a
  // variant carrying its own `:not(…)` tail is compared tail-to-tail rather
  // than being folded into the attribute run, where it would match nothing
  // and every add would splice a fresh duplicate block.
  const requested = rootAttributeSelector(`:root${variant} {`);
  const want = canonicalSelector(requested?.attributes ?? `:root${variant}`);
  const wantQualifier = canonicalSelector(requested?.qualifier ?? '');

  let depth = 0;
  for (const [i, line] of stripped.entries()) {
    const topLevel = depth === 0;
    depth += braceDelta(structure[i] ?? '');
    if (!topLevel) continue;
    const selector = rootAttributeSelector(line);
    if (selector === undefined || canonicalSelector(selector.attributes) !== want) continue;
    if (
      !validateVariantSelector(`${selector.attributes.slice(':root'.length)}${selector.qualifier}`)
        .ok
    )
      continue;
    if (!anyQualifier && canonicalSelector(selector.qualifier) !== wantQualifier) continue;

    let openLine = /\{/.test(line) ? i : -1;
    if (openLine === -1) {
      for (let j = i + 1; j < stripped.length; j++) {
        const next = stripped[j] ?? '';
        if (next.trim() === '') continue;
        if (/^\s*\{/.test(next)) openLine = j;
        break;
      }
    }
    if (openLine === -1) continue;

    const close = findBlockCloseIndex(structure, openLine);
    if (close === -1) continue;
    return { open: openLine, close, qualifier: selector.qualifier };
  }
  return undefined;
}

/**
 * Returns the line index at which a brand-new `:root<variant>` block should
 * be spliced: immediately after the base `:root { }` block's closing brace
 * (so attribute variants sit between the base block and any dark `@media`
 * block). Falls back to end-of-file when no base `:root` block is found.
 */
function findVariantBlockInsertionPoint(lines: string[]): number {
  const stripped = stripBlockCommentsInLines(lines);
  const structure = structureLines(stripped);
  let depth = 0;
  for (const [i, line] of stripped.entries()) {
    if (depth === 0 && /^\s*:root\s*\{/.test(line)) {
      const close = findBlockCloseIndex(structure, i);
      if (close !== -1) return close + 1;
    }
    depth += braceDelta(structure[i] ?? '');
  }
  return lines.length;
}

/**
 * True when a top-level `:root<variant>` block exists in `lines`. Used by
 * the override path to write theme-attribute blocks only when the scaffold
 * already declares them. `insertVariantDeclaration` would otherwise create
 * the block, which is only wanted for the explicit `--variant` flow.
 */
export function variantBlockExists(lines: string[], variant: string): boolean {
  return findVariantBlock(lines, variant) !== undefined;
}

/**
 * The pseudo-class qualifier on the matched `:root<variant>` block, or
 * `undefined` when no block matched. `''` for an unqualified block.
 *
 * This diagnostic lookup may find a qualified block for an unqualified request.
 * Writers must explicitly include the returned qualifier to select that block;
 * ordinary variant insertion and existence checks require an exact qualifier.
 *
 * @param lines - Tokens CSS split into lines
 * @param variant - Attribute selector fragment, e.g. `[data-theme="light"]`
 * @returns The qualifier, or undefined when no block matched
 */
export function variantBlockQualifier(lines: string[], variant: string): string | undefined {
  return findVariantBlock(lines, variant, true)?.qualifier;
}

/** True when the `:root<variant>` block already declares `tokenName`. */
export function variantBlockHasToken(lines: string[], variant: string, tokenName: string): boolean {
  return findVariantBlockDeclaration(lines, variant, tokenName) !== undefined;
}

/**
 * Locates an existing declaration of `tokenName` inside the
 * `:root<variant>` block, or `undefined` when the block has none (or does
 * not exist).
 *
 * The located form of {@link variantBlockHasToken}: the variant add path
 * reports a skip the way the base path does, naming the block and the
 * line, so a no-op re-run is distinguishable from a write.
 *
 * @param lines - Tokens CSS split into lines
 * @param variant - Attribute selector fragment
 * @param tokenName - Full token name including prefix
 * @returns The declaration's 1-based line, or undefined
 */
export function findVariantBlockDeclaration(
  lines: string[],
  variant: string,
  tokenName: string
): TokenDeclarationLocation | undefined {
  const block = findVariantBlock(lines, variant);
  if (!block) return undefined;
  // Comments are stripped across the whole block before scanning, so the
  // tail of a `/* … */` spanning several lines never looks like a declaration.
  const blockLines = lines.slice(block.open, block.close + 1);
  // Blank the comment's characters rather than deleting it: removing a
  // multi-line comment outright collapses its lines and shifts every line
  // number after it, which is the one thing this function exists to report.
  const stripped = blockLines
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .split('\n');
  const structure = structureLines(stripped);
  const declaration = new RegExp(`(?:^|[;{])\\s*${escapeRegex(tokenName)}\\s*:`, 'g');
  let depth = 0;
  for (const [i, line] of structure.entries()) {
    for (const match of line.matchAll(declaration)) {
      const before = line.slice(0, match.index + match[0].length);
      if (depth + braceDelta(before) === 1) return { line: block.open + i + 1 };
    }
    depth += braceDelta(line);
  }
  return undefined;
}

/**
 * Splices `declLine` into the `:root<variant>` block, creating the block
 * (after the base `:root` block) when absent or appending after the last
 * non-blank line when present. Mutates `lines` in place.
 */
export function insertVariantDeclaration(lines: string[], variant: string, declLine: string): void {
  const block = findVariantBlock(lines, variant);
  if (block) {
    const close = isolateBlockClose(lines, block.close);
    let insertIndex = close;
    for (let i = close - 1; i > block.open; i--) {
      if ((lines[i] ?? '').trim()) {
        insertIndex = i + 1;
        break;
      }
    }
    lines.splice(insertIndex, 0, declLine);
    return;
  }
  lines.splice(findVariantBlockInsertionPoint(lines), 0, '', `:root${variant} {`, declLine, '}');
}
