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

import type { TokenDeclarationLocation } from './token-category.js';
import { findBlockCloseIndex, stripBlockCommentsInLines } from './token-dark-mode.js';

/**
 * Outcome of {@link validateVariantSelector}. `ok: true` carries the
 * normalized (quoted) selector fragment; `ok: false` carries a
 * human-readable reason suitable for throwing as an `InvalidArgumentError`.
 */
export type VariantValidation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * ONE attribute selector fragment: `[data-private]` (boolean attribute) or
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
 * argument is captured rather than validated here — it is a fragment run of
 * its own and goes through the same per-group check.
 */
const QUALIFIER_PATTERN = /^:[a-zA-Z][a-zA-Z0-9-]*(?:\(([^()]*)\))?$/;

/**
 * Splits a run of consecutive attribute fragments into its groups, or
 * returns `undefined` when the run is not exactly that — a group that does not
 * open with `[`, an unclosed group, an empty run, or a group whose name or
 * value is not identifier-safe.
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
 * Structure is decided by {@link rootAttributeSelector} — the matcher's own
 * parse — rather than by a second regex. That is the point: 0.44.2 widened
 * the matcher to consume consecutive `[…]` groups and stop at a pseudo-class
 * tail, and the validator did not move with it, so
 * `:root[data-skin="humanist"]:not([data-private])` was a block the tool
 * could FIND but would not let you NAME. Running both halves off one parse
 * is what stops them drifting apart again. Character-level safety stays a
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
  // The parse must have consumed the WHOLE fragment: anything it declined to
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
   * Whatever sits between the attribute run and the block's `{` — a
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
 * It consumes CONSECUTIVE `[…]` groups and stops at the first character that
 * is not `[`. The previous implementation instead sliced to the LAST `]`
 * before the brace, which kept multi-attribute selectors comparing as a
 * whole — that property is preserved here, since consecutive groups are all
 * consumed — but it also swallowed a pseudo-class tail. On
 * `:root[data-theme="light"]:not([data-private]) {` the last `]` is the one
 * inside `:not(…)`, so the computed fragment was
 * `:root[data-theme="light"]:not([data-private]` and the canonical
 * comparison could never match. The unqualified
 * `:root[data-theme="dark"] { }` beside it matched fine, and that asymmetry
 * WAS the bug: an override add mirrored itself into the dark block and
 * silently skipped the light one, which is precisely the half-finished
 * themed edit `THEME_ATTRIBUTE_VARIANTS` exists to prevent.
 */
function rootAttributeSelector(line: string): RootSelectorParts | undefined {
  const start = line.indexOf(':root[');
  if (start === -1) return undefined;
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

/**
 * Finds the top-level `:root<variant>` block whose attribute selector
 * matches `variant` (compared canonically). Returns the opening-brace and
 * closing-brace line indices, or `undefined` when no such block exists.
 *
 * Scans a comment-stripped mirror of `lines` so braces inside comments do
 * not offset the depth counter; the returned indices line up with the
 * original array.
 */
function findVariantBlock(lines: string[], variant: string): VariantBlock | undefined {
  const stripped = stripBlockCommentsInLines(lines);
  // The request goes through the same parse as the candidate lines, so a
  // variant carrying its own `:not(…)` tail is compared tail-to-tail rather
  // than being folded into the attribute run — where it would match nothing
  // and every add would splice a fresh duplicate block.
  const requested = rootAttributeSelector(`:root${variant} {`);
  const want = canonicalSelector(requested?.attributes ?? `:root${variant}`);
  const wantQualifier = canonicalSelector(requested?.qualifier ?? '');

  for (const [i, line] of stripped.entries()) {
    const selector = rootAttributeSelector(line);
    if (selector === undefined || canonicalSelector(selector.attributes) !== want) continue;
    // An UNqualified request still matches a qualified block: that is the
    // 0.44.2 behaviour `variantBlockQualifier` exists to report, since
    // silently skipping the block is the worse failure. A request that names
    // a qualifier, though, means it — so it must match.
    if (wantQualifier !== '' && canonicalSelector(selector.qualifier) !== wantQualifier) continue;

    let openLine = /\{/.test(line) ? i : -1;
    if (openLine === -1) {
      for (let j = i + 1; j < stripped.length; j++) {
        const next = stripped[j] ?? '';
        if (/\{/.test(next)) {
          openLine = j;
          break;
        }
        if (/[};]/.test(next)) break;
      }
    }
    if (openLine === -1) continue;

    const close = findBlockCloseIndex(stripped, openLine);
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
  for (const [i, line] of stripped.entries()) {
    if (/^\s*:root\s*\{/.test(line)) {
      const close = findBlockCloseIndex(stripped, i);
      if (close !== -1) return close + 1;
    }
  }
  return lines.length;
}

/**
 * True when a top-level `:root<variant>` block exists in `lines`. Used by
 * the override path to write theme-attribute blocks only when the scaffold
 * already declares them — `insertVariantDeclaration` would otherwise create
 * the block, which is only wanted for the explicit `--variant` flow.
 */
export function variantBlockExists(lines: string[], variant: string): boolean {
  return findVariantBlock(lines, variant) !== undefined;
}

/**
 * The pseudo-class qualifier on the matched `:root<variant>` block, or
 * `undefined` when no block matched. `''` for an unqualified block.
 *
 * A qualifier such as `:not([data-private])` is semantically LOAD-BEARING:
 * writing into that block scopes the declaration to the qualified case, and
 * that may not be what the operator meant. Matching it is still the right
 * call — silently skipping it is the worse failure, and the one that
 * shipped — but the override path uses this to say out loud which selector
 * it wrote through, so the narrowing is a visible decision rather than a
 * theme bug discovered later.
 *
 * @param lines - Tokens CSS split into lines
 * @param variant - Attribute selector fragment, e.g. `[data-theme="light"]`
 * @returns The qualifier, or undefined when no block matched
 */
export function variantBlockQualifier(lines: string[], variant: string): string | undefined {
  return findVariantBlock(lines, variant)?.qualifier;
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
 * reports a skip the way the base path does — naming the block and the
 * line — instead of returning a bare boolean that leaves a no-op re-run
 * indistinguishable from a write.
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
  // Comments are stripped across the WHOLE block before scanning, matching
  // what the boolean form always did: a `/* … */` spanning several lines
  // must not leave its tail looking like a declaration.
  const blockLines = lines.slice(block.open, block.close + 1);
  // Blank the comment's CHARACTERS rather than deleting it: removing a
  // multi-line comment outright collapses its lines and shifts every line
  // number after it, which is the one thing this function exists to report.
  const stripped = blockLines
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .split('\n');
  for (const [i, line] of stripped.entries()) {
    if (line.includes(`${tokenName}:`)) return { line: block.open + i + 1 };
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
    let insertIndex = block.close;
    for (let i = block.close - 1; i > block.open; i--) {
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
