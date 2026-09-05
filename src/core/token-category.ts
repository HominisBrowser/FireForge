// SPDX-License-Identifier: EUPL-1.2
/**
 * Category banner and token-declaration helpers for the tokens CSS file.
 * Split out of `token-manager.ts` to stay inside the per-file line budget.
 *
 * Banner matching is EXACT: the text between the `=` runs (single-line
 * shape) or on the block line (multi-line shape) must equal the category
 * after trimming. A substring match lets a TOC comment or a longer banner
 * (`Colors — Canvas` for `Colors`) satisfy the lookup, so `token add` writes
 * into the wrong section — or no-ops — with exit 0.
 */
import { join } from 'node:path';

import { GeneralError } from '../errors/base.js';
import { pathExists, readText } from '../utils/fs.js';
import { escapeRegex } from '../utils/regex.js';

function singleLineBannerPattern(category: string): RegExp {
  return new RegExp(`\\/\\*\\s*=+\\s*${escapeRegex(category)}\\s*=+\\s*\\*\\/`);
}

function multiLineBlockNameMatches(blockLine: string, category: string): boolean {
  return blockLine.replace(/^\s*\*\s*/, '').trim() === category;
}

/**
 * Body of the first `/* … *\/` comment on `line`, or `undefined` when the
 * line carries no closed block comment.
 *
 * Deliberately index arithmetic rather than a regex: every regex spelling of
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
 * True when `line` carries a single-line banner comment — a closed block
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
 * are required; a decorative all-`=` rule carries no name and yields
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
 * banner shape) whose name EQUALS `category`. Shared by the pre-add
 * assertion, the banner creation path, and the section finder so all
 * agree on what "exists" means.
 */
export function categoryHeaderExists(lines: string[], category: string): boolean {
  const singleLinePattern = singleLineBannerPattern(category);

  for (const [i, line] of lines.entries()) {
    if (singleLinePattern.test(line)) {
      return true;
    }

    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (multiLineBlockNameMatches(blockLine, category)) {
          return true;
        }
        if (/\*\//.test(blockLine)) break;
      }
    }
  }
  return false;
}

/**
 * Scans a tokens CSS file for category header comments and returns the
 * category names in document order. Used to enrich the "category not
 * found" error body with concrete alternatives the operator can copy.
 *
 * Mirrors the shapes `findCategorySection` recognises:
 * - Single-line: `/* = Foo = *\/`
 * - Multi-line: `/* =====` opening, `Foo` on any of the next ~5 lines,
 *   closing `*\/`.
 *
 * This helper exists as a pure inspector; it never throws on malformed
 * headers and silently skips shapes it cannot parse.
 */
/**
 * Category name declared by the banner STARTING at `index`, or `undefined`
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
export function categoryBannerNameAt(lines: string[], index: number): string | undefined {
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
  const categories = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const name = categoryBannerNameAt(lines, i);
    if (name !== undefined) categories.add(name);
  }
  return [...categories];
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
  const singleLinePattern = singleLineBannerPattern(category);

  let categoryLine = -1;
  for (const [i, line] of lines.entries()) {
    // Check single-line format: /* = Category = */
    if (singleLinePattern.test(line)) {
      categoryLine = i;
      break;
    }

    // Check multi-line format: line opens a block comment with === but does NOT close it
    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (multiLineBlockNameMatches(blockLine, category)) {
          categoryLine = i;
          break;
        }
        if (/\*\//.test(blockLine)) break;
      }
      if (categoryLine !== -1) break;
    }
  }

  if (categoryLine === -1) {
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

  // Find the end of this category section (next section header or closing })
  // Skip past the current header block first
  let scanStart = categoryLine + 1;
  for (let i = categoryLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*\/\*\s*=/.test(line) || /^\s*\*\s*=/.test(line) || /^\s*\*\//.test(line)) {
      scanStart = i + 1;
      continue;
    }
    break;
  }

  let sectionEnd = lines.length;
  for (let i = scanStart; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (
      isSingleLineBannerLine(line) ||
      (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) ||
      /^\s*\}/.test(line)
    ) {
      sectionEnd = i;
      break;
    }
  }

  return { categoryLine, sectionEnd };
}

/** 0-based open/close line indices of the base `:root {` block. */
export function findBaseRootBounds(lines: string[]): { open: number; close: number } | undefined {
  const open = lines.findIndex((line) => /:root\s*\{/.test(line));
  if (open === -1) return undefined;
  for (let i = open + 1; i < lines.length; i++) {
    if (/^\s*\}/.test(lines[i] ?? '')) {
      return { open, close: i };
    }
  }
  return { open, close: -1 };
}

/** Masks block-comment content per line so declarations inside comments never match. */
export function maskCommentLines(lines: string[]): string[] {
  const masked = lines.join('\n').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return masked.split('\n');
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
 * deliberately excluded — they mirror the base declaration, they do not
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
  const declPattern = new RegExp(`^\\s*${escapeRegex(tokenName)}\\s*:`);
  for (let i = bounds.open + 1; i < bounds.close; i++) {
    if (!declPattern.test(masked[i] ?? '')) continue;
    const category = findSectionNameAbove(lines, i);
    return category === undefined ? { line: i + 1 } : { line: i + 1, category };
  }
  return undefined;
}

/** Nearest category banner name above `lineIndex`, if any. */
function findSectionNameAbove(lines: string[], lineIndex: number): string | undefined {
  const singleLinePattern = /\/\*\s*=+\s*(.+?)\s*=+\s*\*\//;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const singleMatch = singleLinePattern.exec(line);
    if (singleMatch?.[1]) {
      const extracted = singleMatch[1].trim();
      if (extracted.length > 0 && !/^=+$/.test(extracted)) return extracted;
      continue;
    }
    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (/\*\//.test(blockLine)) break;
        const trimmed = blockLine.replace(/^\s*\*\s*/, '').trim();
        if (trimmed.length === 0 || /^=+$/.test(trimmed)) continue;
        return trimmed;
      }
    }
  }
  return undefined;
}
