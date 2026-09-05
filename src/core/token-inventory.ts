// SPDX-License-Identifier: EUPL-1.2
/**
 * Read-only inventory of the tokens CSS file: which categories exist, which
 * tokens each declares, and what a single token resolves to in every theme
 * block that mentions it.
 *
 * `token add` requires `--category` and, until now, nothing reported the
 * categories a project actually has, so the only way to name one correctly
 * was to hand-parse a neighbouring `= Category =` banner out of the file.
 * This module is that report. It reuses the banner and
 * `:root`-bounds primitives from `token-category.ts` rather than parsing
 * tokens CSS a second way: two readers that disagree on what a banner is
 * would put `token list` and `token add` in different sections of the same
 * file.
 */
import { categoryBannerNameAt, findBaseRootBounds, maskCommentLines } from './token-category.js';

/** One token declaration inside the base `:root` block. */
export interface TokenInventoryEntry {
  /** Custom-property name, including the leading `--`. */
  name: string;
  /** 1-based line number in the tokens CSS file. */
  line: number;
  /** Declared value, trimmed, without the trailing `;`. */
  value: string;
}

/**
 * Tokens grouped under the banner that precedes them, in file order.
 * `category` is null for declarations that sit above the first banner.
 * That is a real state in a hand-edited file, and one the report must show
 * rather than silently drop.
 */
export interface TokenCategoryInventory {
  category: string | null;
  tokens: TokenInventoryEntry[];
}

/** One block that declares a given token, with the value it declares. */
export interface TokenBlockValue {
  /**
   * Selector trail of the declaring block, outermost first, joined with
   * ` > `. For example `:root` or
   * `@media (prefers-color-scheme: dark) > :root`.
   */
  block: string;
  value: string;
  /** 1-based line number of the declaration. */
  line: number;
}

/** Matches a custom-property declaration and captures its name and value. */
const DECLARATION_PATTERN = /^\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;]*);?/;

/**
 * Collects every base-`:root` token declaration grouped by the category
 * banner above it, in document order.
 *
 * Only the base block is walked: the dark `@media` and `:root[variant]`
 * companions mirror declarations rather than owning them, so listing them
 * would report the same token two or three times under no category at all.
 *
 * @param lines - Tokens CSS split into lines
 * @returns Categories in file order, each with its tokens in file order
 */
export function collectTokenInventory(lines: string[]): TokenCategoryInventory[] {
  const bounds = findBaseRootBounds(lines);
  if (bounds === undefined || bounds.close === -1) return [];

  const masked = maskCommentLines(lines);
  const groups: TokenCategoryInventory[] = [];
  let current: TokenCategoryInventory | undefined;

  for (let i = bounds.open + 1; i < bounds.close; i++) {
    // Banners are read from the raw lines: `maskCommentLines` blanks comment
    // bodies, which is exactly what a banner is.
    const banner = categoryBannerNameAt(lines, i);
    if (banner !== undefined) {
      current = { category: banner, tokens: [] };
      groups.push(current);
      continue;
    }
    const match = DECLARATION_PATTERN.exec(masked[i] ?? '');
    if (!match?.[1]) continue;
    if (current === undefined) {
      current = { category: null, tokens: [] };
      groups.push(current);
    }
    current.tokens.push({ name: match[1], line: i + 1, value: (match[2] ?? '').trim() });
  }

  // A banner with no declarations under it is still a category `token add
  // --category` accepts, so empty groups are kept.
  return groups;
}

/**
 * Every declaration of `tokenName`, in every block of the file, labelled by
 * the selector trail of the block that declares it.
 *
 * Not restricted to the base `:root`: the question `token show`
 * answers is "what does this token resolve to", and a token whose dark
 * override differs from its base value is the case worth seeing.
 *
 * @param lines - Tokens CSS split into lines
 * @param tokenName - Custom-property name including the leading `--`
 * @returns Declarations in file order
 */
export function collectTokenBlockValues(lines: string[], tokenName: string): TokenBlockValue[] {
  const masked = maskCommentLines(lines);
  const trail: string[] = [];
  const found: TokenBlockValue[] = [];

  for (let i = 0; i < masked.length; i++) {
    const line = masked[i] ?? '';
    const match = DECLARATION_PATTERN.exec(line);
    if (match?.[1] === tokenName) {
      found.push({
        block: trail.length > 0 ? trail.join(' > ') : '(file scope)',
        value: (match[2] ?? '').trim(),
        line: i + 1,
      });
    }
    // Brace tracking after the declaration test, so a one-line block cannot
    // swallow the declaration it opens on. Selector text is whatever
    // precedes the `{`. An empty selector (a continuation line) still
    // needs a stack entry or the closing `}` pops the wrong one.
    for (const char of line) {
      if (char === '{') {
        trail.push(selectorBefore(line, trail.length));
      } else if (char === '}') {
        trail.pop();
      }
    }
  }
  return found;
}

/**
 * Selector text introducing the `depth`-th open brace on `line`. Falls back
 * to a positional label so the trail stays well-formed on a minified or
 * continuation line that opens a block with no visible selector.
 */
function selectorBefore(line: string, depth: number): string {
  const open = line.indexOf('{');
  const text = open === -1 ? '' : line.slice(0, open).trim();
  return text.length > 0 ? text : `(block ${String(depth + 1)})`;
}
