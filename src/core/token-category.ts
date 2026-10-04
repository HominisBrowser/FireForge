// SPDX-License-Identifier: EUPL-1.2
/**
 * Category banner and token-declaration helpers for the tokens CSS file.
 * Split out of `token-manager.ts` to stay inside the per-file line budget.
 *
 * Banner matching is exact: the text between the `=` runs (single-line
 * shape) or on the block line (multi-line shape) must equal the category
 * after trimming. With a substring match, a TOC comment or a longer banner
 * whose name merely starts with the category (a canvas colors banner
 * satisfying a lookup for `Colors`) would also match, and `token add` would
 * then write into the wrong section, or no-op, with exit 0.
 */
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';

/**
 * Body of the first `/* … *\/` comment on `line`, or `undefined` when the
 * line carries no closed block comment.
 *
 * This uses index arithmetic rather than a regex: every regex spelling of
 * "banner comment" this module used to carry was super-linear on a line that
 * repeats the opening shape (CodeQL `js/polynomial-redos`), and `tokens.css`
 * is a file FireForge reads out of a consumer's engine tree, so a
 * pathological line needs no attacker to arrive.
 */
function blockCommentBody(line: string): string | undefined {
  const open = line.indexOf('/*');
  if (open === -1) return undefined;
  const close = line.indexOf('*/', open + 2);
  if (close === -1) return undefined;
  return line.slice(open + 2, close);
}

/**
 * True when `line` carries a single-line banner comment: a closed block
 * comment whose body both opens and closes with `=`. Recognises the decorative
 * all-`=` rule as well as a named `= Foo =` banner, which is what the section
 * scan wants: either shape ends the preceding section.
 */
function isSingleLineBannerLine(line: string): boolean {
  const body = blockCommentBody(line)?.trim();
  return body !== undefined && body.length >= 2 && body.startsWith('=') && body.endsWith('=');
}

/**
 * Name declared by a single-line banner (`/* = Foo = *\/` → `Foo`), or
 * `undefined` when the line is not a named banner. The `=` runs on both sides
 * are required. A decorative all-`=` rule carries no name and yields
 * `undefined`.
 */
function singleLineBannerName(line: string): string | undefined {
  const body = blockCommentBody(line);
  if (body === undefined) return undefined;

  let start = 0;
  let end = body.length;
  while (start < end && /\s/.test(body[start] ?? '')) start++;
  const leadingEqStart = start;
  while (start < end && body[start] === '=') start++;
  if (start === leadingEqStart) return undefined;

  while (end > start && /\s/.test(body[end - 1] ?? '')) end--;
  const trailingEqEnd = end;
  while (end > start && body[end - 1] === '=') end--;
  if (end === trailingEqEnd) return undefined;

  const name = body.slice(start, end).trim();
  return name.length > 0 ? name : undefined;
}

/**
 * True when `lines` contain a category header (single-line or multi-line
 * banner shape) whose name equals `category`. Shared by the pre-add
 * assertion, the banner creation path, and the section finder so all
 * agree on what "exists" means.
 */
export function categoryHeaderExists(lines: string[], category: string): boolean {
  return parseTokenCategorySections(lines).some((section) => section.name === category);
}

/**
 * Category name declared by the banner starting at `index`, or `undefined`
 * when that line opens no banner.
 *
 * The single reader for both banner shapes, so the inventory walk, the
 * "available categories" error body and the section finder cannot drift on
 * what counts as a header.
 *
 * @param lines - Tokens CSS split into lines
 * @param index - 0-based line index to test
 * @returns The declared category name, or undefined
 */
function categoryBannerNameAt(lines: string[], index: number): string | undefined {
  const line = lines[index] ?? '';
  const extracted = singleLineBannerName(line);
  if (extracted !== undefined) return extracted;

  if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
    for (let j = index + 1; j < Math.min(index + 6, lines.length); j++) {
      const blockLine = lines[j] ?? '';
      if (/\*\//.test(blockLine)) break;
      const trimmed = blockLine.replace(/^\s*\*\s*/, '').trim();
      if (trimmed.length === 0) continue;
      if (/^=+$/.test(trimmed)) continue;
      return trimmed;
    }
  }
  return undefined;
}

function discoverCategoryHeaders(lines: string[]): string[] {
  return [...new Set(parseTokenCategorySections(lines).map((section) => section.name))];
}

export interface TokenCategorySection {
  name: string;
  categoryLine: number;
  sectionEnd: number;
}

/** Parses category regions owned by the base root, including nested CSS rules. */
export function parseTokenCategorySections(lines: string[]): TokenCategorySection[] {
  const bounds = findBaseRootBounds(lines);
  if (bounds === undefined || bounds.close === -1) return [];
  const masked = maskCommentLines(lines);
  const sections: TokenCategorySection[] = [];
  let current: TokenCategorySection | undefined;
  let bodyStarted = false;
  for (let index = bounds.open + 1; index < bounds.close; index++) {
    const line = lines[index] ?? '';
    const name = categoryBannerNameAt(lines, index);
    const boundary = name !== undefined || isSingleLineBannerLine(line);
    if (!boundary) {
      if ((masked[index] ?? '').trim()) bodyStarted = true;
      continue;
    }
    // A decorative rule immediately after a named header belongs to that
    // header. A later rule, after declarations, ends its section.
    if (name === undefined && current && !bodyStarted) continue;
    if (current) current.sectionEnd = index;
    current = undefined;
    if (name !== undefined) {
      current = { name, categoryLine: index, sectionEnd: bounds.close };
      bodyStarted = false;
      sections.push(current);
    }
  }
  return sections;
}

/**
 * Asserts the category banner exists (or that creation was requested).
 * Throws a GeneralError naming the available categories and the
 * `--create-category` remedy otherwise.
 */
export async function assertTokenCategoryExists(
  engineDir: string,
  tokensCssPath: string,
  category: string,
  createCategory = false
): Promise<void> {
  const filePath = join(engineDir, tokensCssPath);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`Token CSS file not found: ${tokensCssPath}`);
  }

  const content = await readText(filePath);
  const lines = content.split('\n');
  if (categoryHeaderExists(lines, category)) return;
  // The write path declares the banner in the same edit as the token
  // insertion, so a missing category is fine when creation was requested.
  if (createCategory) return;

  const discoveredCategories = discoverCategoryHeaders(lines);
  const available =
    discoveredCategories.length > 0
      ? `Available categories in the file: ${discoveredCategories.map((name) => `"${name}"`).join(', ')}.`
      : 'The file currently has no category headers.';

  throw new GeneralError(
    `Category "${category}" not found in ${tokensCssPath}.\n\n` +
      `${available}\n\n` +
      'Categories are declared by comment headers. Single-line shape: /* = My Category = */. ' +
      'Multi-line shape: /* =============\\n * My Category\\n * ============= */.\n\n' +
      'Re-run with --create-category to declare the banner and insert the token in one step.'
  );
}

/**
 * Splices a new single-line category banner ("= Name =" comment shape, the
 * same format `discoverCategoryHeaders` recognises) just before the closing
 * brace of the `:root` block, making the new category the last section.
 * Mutates `lines` in place.
 */
export function declareCategoryBanner(
  lines: string[],
  category: string,
  tokensCssPath: string
): void {
  const bounds = findBaseRootBounds(lines);
  if (bounds === undefined) {
    throw new GeneralError(
      `Cannot create category "${category}": no :root block found in ${tokensCssPath}. ` +
        'Run "fireforge furnace init --force" to re-scaffold the tokens CSS file.'
    );
  }
  if (bounds.close === -1) {
    throw new GeneralError(
      `Cannot create category "${category}": the :root block in ${tokensCssPath} never closes.`
    );
  }
  lines.splice(bounds.close, 0, '', `  /* = ${category} = */`);
}

/** Locates and bounds the named category section. Throws when absent. */
export function findCategorySection(
  lines: string[],
  category: string,
  tokensCssPath: string
): { categoryLine: number; sectionEnd: number } {
  const sections = parseTokenCategorySections(lines);
  const section = sections.find((entry) => entry.name === category);
  if (section === undefined) {
    const discoveredCategories = discoverCategoryHeaders(lines);
    const available =
      discoveredCategories.length > 0
        ? `Available categories in the file: ${discoveredCategories.map((name) => `"${name}"`).join(', ')}.`
        : 'The file currently has no category headers.';

    throw new GeneralError(
      `Category "${category}" not found in ${tokensCssPath}.\n\n` +
        `${available}\n\n` +
        'Add a header by hand inside the :root block (format: "/* = My Category = */") or re-run "fireforge furnace init --force" to re-seed the default categories.'
    );
  }

  return { categoryLine: section.categoryLine, sectionEnd: section.sectionEnd };
}

/**
 * Drops complete quoted strings from one CSS line in linear time. An
 * unterminated quote is kept, and once one fails to close every later quote
 * of that kind fails too, so no start position is ever rescanned.
 */
function stripCssStrings(line: string): string {
  let out = '';
  const unterminated = new Set<string>();
  for (let i = 0; i < line.length; i++) {
    const quote = line.charAt(i);
    if ((quote !== '"' && quote !== "'") || unterminated.has(quote)) {
      out += quote;
      continue;
    }
    let end = i + 1;
    while (end < line.length && line.charAt(end) !== quote)
      end += line.charAt(end) === '\\' ? 2 : 1;
    if (end >= line.length) {
      unterminated.add(quote);
      out += quote;
    } else {
      i = end;
    }
  }
  return out;
}

/** 0-based open/close line indices of the base `:root {` block. */
export function findBaseRootBounds(lines: string[]): { open: number; close: number } | undefined {
  const open = lines.findIndex((line) => /:root\s*\{/.test(line));
  if (open === -1) return undefined;
  const masked = maskCommentLines(lines);
  let depth = 0;
  for (let i = open; i < lines.length; i++) {
    // Ignore braces in CSS strings (including data URLs).
    const code = stripCssStrings(masked[i] ?? '');
    for (const char of code) {
      if (char === '{') depth++;
      if (char === '}' && --depth === 0) return { open, close: i };
    }
  }
  return { open, close: -1 };
}

/** Masks block-comment content per line so declarations inside comments never match. */
export function maskCommentLines(lines: string[]): string[] {
  const source = lines.join('\n');
  const parts: string[] = [];
  let cursor = 0;
  for (;;) {
    const open = source.indexOf('/*', cursor);
    if (open === -1) break;
    const close = source.indexOf('*/', open + 2);
    // An unfinished edit has no complete comment to mask. Searching only
    // once prevents restarting a regex at every repeated comment opener.
    if (close === -1) break;
    parts.push(source.slice(cursor, open), source.slice(open, close + 2).replace(/[^\n]/g, ' '));
    cursor = close + 2;
  }
  parts.push(source.slice(cursor));
  return parts.join('').split('\n');
}

/** Location of an existing base-`:root` token declaration. */
export interface TokenDeclarationLocation {
  /** 1-based line number in the tokens CSS file. */
  line: number;
  /** Nearest enclosing category banner name, when one precedes the declaration. */
  category?: string;
}

/**
 * Finds an existing declaration of `tokenName` inside the base `:root`
 * block. Dark `@media` and `:root[variant]` companion blocks are
 * excluded: they mirror the base declaration, they do not
 * own the token. Comment content never matches, and the name match is
 * exact (`--foo-bar` does not match `--x-foo-bar`).
 */
export function findTokenDeclarationInRoot(
  lines: string[],
  tokenName: string
): TokenDeclarationLocation | undefined {
  const bounds = findBaseRootBounds(lines);
  if (bounds === undefined || bounds.close === -1) return undefined;

  const masked = maskCommentLines(lines);
  const sections = parseTokenCategorySections(lines);
  const declPattern = new RegExp(`^\\s*${escapeRegex(tokenName)}\\s*:`);
  for (let i = bounds.open + 1; i < bounds.close; i++) {
    if (!declPattern.test(masked[i] ?? '')) continue;
    const category = sections.find(
      (section) => i > section.categoryLine && i < section.sectionEnd
    )?.name;
    return category === undefined ? { line: i + 1 } : { line: i + 1, category };
  }
  return undefined;
}
