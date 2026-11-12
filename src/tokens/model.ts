// SPDX-License-Identifier: EUPL-1.2
/**
 * The token file: which categories its base `:root` block is divided into,
 * which tokens each declares, and what a token resolves to in every block.
 *
 * A category is a banner comment inside the base block, either one line
 * (`/* = Spacing = *\/`) or a boxed block whose first text line is the name.
 * It owns everything up to the next banner. A decorative rule of only `=`
 * ends a section once the section has declarations, and belongs to the
 * section's own banner before that.
 */
import {
  type CssBlock,
  type CssComment,
  customProperties,
  parseCss,
  type Stylesheet,
} from '../syntax/index.js';
import { baseRoot } from './css.js';

/** One category banner in the base block. */
export interface TokenCategory {
  name: string;
  /** Line of the banner (zero-based). */
  line: number;
  /** First line after the section. */
  end: number;
}

/** One token declared in the base block. */
export interface TokenEntry {
  name: string;
  /** One-based line. */
  line: number;
  value: string;
}

/** The tokens of one category, in file order. `category` is null above the first banner. */
export interface TokenGroup {
  category: string | null;
  tokens: TokenEntry[];
}

/** One declaration of a token and the block that holds it. */
export interface TokenValue {
  /** Enclosing selectors, outermost first, joined with ` > `; `(file scope)` outside any rule. */
  block: string;
  value: string;
  /** One-based line. */
  line: number;
}

/** What a banner comment declares: a name, a decorative rule (`''`), or nothing (undefined). */
function bannerName(comment: CssComment): string | undefined {
  const text = comment.text.trim();
  if (!text.startsWith('=')) return undefined;
  if (comment.start === comment.end) {
    if (!text.endsWith('=')) return undefined;
    return text.replace(/^=+/, '').replace(/=+$/, '').trim();
  }
  const rows = text.split('\n').map((row) => row.replace(/^\s*\*\s?/, '').trim());
  return rows.find((row) => row !== '' && !/^=+$/.test(row)) ?? '';
}

function within(root: CssBlock, line: number): boolean {
  return line > root.open && (root.close === -1 || line < root.close);
}

/**
 * The categories of the base block, in file order. Empty when the file has
 * no closed base block.
 *
 * @param sheet - The parsed token file
 */
export function categories(sheet: Stylesheet): TokenCategory[] {
  const root = baseRoot(sheet);
  if (root === undefined || root.close === -1) return [];
  const found: TokenCategory[] = [];
  let current: TokenCategory | undefined;
  for (const comment of sheet.comments) {
    if (!within(root, comment.start)) continue;
    const name = bannerName(comment);
    if (name === undefined) continue;
    if (name === '' && current !== undefined) {
      const owner = current;
      const started = customProperties(sheet).some(
        (declaration) =>
          declaration.block === root &&
          declaration.line > owner.line &&
          declaration.line < comment.start
      );
      if (!started) continue;
    }
    if (current !== undefined) current.end = comment.start;
    current = undefined;
    if (name !== '') {
      current = { name, line: comment.start, end: root.close };
      found.push(current);
    }
  }
  return found;
}

/**
 * The tokens declared in the base block, grouped under the banner above
 * them. A banner without tokens is still a group.
 *
 * @param text - The token file
 */
export function listTokens(text: string): TokenGroup[] {
  const sheet = parseCss(text);
  const root = baseRoot(sheet);
  if (root === undefined) return [];
  const sections = categories(sheet);
  const groups: TokenGroup[] = sections.map((section) => ({ category: section.name, tokens: [] }));
  const loose: TokenGroup = { category: null, tokens: [] };
  for (const declaration of customProperties(sheet)) {
    if (declaration.block !== root) continue;
    const index = sections.findIndex(
      (section) => declaration.line > section.line && declaration.line < section.end
    );
    const entry = { name: declaration.name, line: declaration.line + 1, value: declaration.value };
    (index === -1 ? loose : groups[index])?.tokens.push(entry);
  }
  return loose.tokens.length > 0 ? [loose, ...groups] : groups;
}

/** The selectors enclosing a declaration, outermost first, joined with ` > `. */
export function blockPath(block: CssBlock | undefined): string {
  const selectors: string[] = [];
  for (let at = block; at !== undefined; at = at.parent)
    selectors.unshift(at.selector || '(block)');
  return selectors.length > 0 ? selectors.join(' > ') : '(file scope)';
}

/**
 * Every declaration of a token in the file, labelled by its block.
 *
 * @param text - The token file
 * @param name - Custom property name, with `--`
 */
export function tokenValues(text: string, name: string): TokenValue[] {
  return customProperties(parseCss(text))
    .filter((declaration) => declaration.name === name)
    .map((declaration) => ({
      block: blockPath(declaration.block),
      value: declaration.value,
      line: declaration.line + 1,
    }));
}

/**
 * Every custom property the file declares, in any block.
 *
 * @param text - A stylesheet
 */
export function declaredTokens(text: string): Set<string> {
  return new Set(customProperties(parseCss(text)).map((declaration) => declaration.name));
}
