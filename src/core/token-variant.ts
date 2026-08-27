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

import { findBlockCloseIndex, stripBlockCommentsInLines } from './token-dark-mode.js';

/**
 * Outcome of {@link validateVariantSelector}. `ok: true` carries the
 * normalized (quoted) selector fragment; `ok: false` carries a
 * human-readable reason suitable for throwing as an `InvalidArgumentError`.
 */
export type VariantValidation = { ok: true; value: string } | { ok: false; reason: string };

/**
 * Accepts a single attribute selector fragment: `[data-private]` (boolean
 * attribute) or `[data-skin=precision]` / `[data-skin="precision"]`
 * (attribute with value). The value half is restricted to identifier-safe
 * characters so the fragment can be spliced into CSS verbatim without
 * escaping concerns.
 */
const VARIANT_PATTERN =
  /^\[[a-zA-Z][a-zA-Z0-9_-]*(?:=(?:"[a-zA-Z0-9_-]+"|'[a-zA-Z0-9_-]+'|[a-zA-Z0-9_-]+))?\]$/;

/**
 * Validates a `--variant` attribute selector fragment and normalizes any
 * `=value` form to the double-quoted `="value"` shape (Mozilla convention).
 * Boolean-attribute fragments are returned unchanged.
 *
 * @param raw - Raw `--variant` value from the CLI / programmatic caller.
 */
export function validateVariantSelector(raw: unknown): VariantValidation {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'must be a string when set' };
  }
  const value = raw.trim();
  if (!VARIANT_PATTERN.test(value)) {
    return {
      ok: false,
      reason:
        'must be a single attribute selector like [data-private] or [data-skin=precision] ' +
        '(identifier-safe attribute name and value only)',
    };
  }
  const normalized = value
    .replace(/='([a-zA-Z0-9_-]+)'\]$/, '="$1"]')
    .replace(/=([a-zA-Z0-9_-]+)\]$/, '="$1"]');
  return { ok: true, value: normalized };
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

/** A located `:root<variant>` block: `open`/`close` are line indices. */
interface VariantBlock {
  open: number;
  close: number;
}

/**
 * Finds the top-level `:root<variant>` block whose attribute selector
 * matches `variant` (compared canonically). Returns the opening-brace and
 * closing-brace line indices, or `null` when no such block exists.
 *
 * Scans a comment-stripped mirror of `lines` so braces inside comments do
 * not offset the depth counter; the returned indices line up with the
 * original array.
 */
function findVariantBlock(lines: string[], variant: string): VariantBlock | null {
  const stripped = stripBlockCommentsInLines(lines);
  const want = canonicalSelector(`:root${variant}`);

  for (let i = 0; i < stripped.length; i++) {
    const line = stripped[i] ?? '';
    const match = /:root\[[^{]*\]/.exec(line);
    if (!match || canonicalSelector(match[0]) !== want) continue;

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
    return { open: openLine, close };
  }
  return null;
}

/**
 * Returns the line index at which a brand-new `:root<variant>` block should
 * be spliced: immediately after the base `:root { }` block's closing brace
 * (so attribute variants sit between the base block and any dark `@media`
 * block). Falls back to end-of-file when no base `:root` block is found.
 */
function findVariantBlockInsertionPoint(lines: string[]): number {
  const stripped = stripBlockCommentsInLines(lines);
  for (let i = 0; i < stripped.length; i++) {
    if (/^\s*:root\s*\{/.test(stripped[i] ?? '')) {
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
  return findVariantBlock(lines, variant) !== null;
}

/** True when the `:root<variant>` block already declares `tokenName`. */
export function variantBlockHasToken(lines: string[], variant: string, tokenName: string): boolean {
  const block = findVariantBlock(lines, variant);
  if (!block) return false;
  const blockText = lines
    .slice(block.open, block.close + 1)
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return blockText.includes(`${tokenName}:`);
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
