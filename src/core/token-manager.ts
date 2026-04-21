// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { FurnaceError } from '../errors/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { escapeRegex } from '../utils/regex.js';
import { validateTokenName } from '../utils/validation.js';
import { getProjectPaths, loadConfig } from './config.js';
import { loadFurnaceConfig } from './furnace-config.js';
import {
  findTableAfterHeading,
  findTableByColumns,
  insertRow,
  rewriteTableRows,
  updateCellByKey,
} from './markdown-table.js';
import { findDarkMediaCloseIndex, findDarkRootInsertionIndex } from './token-dark-mode.js';

/**
 * Dark mode behavior for a token.
 */
export type TokenMode = 'auto' | 'static' | 'override';

/**
 * Options for adding a token.
 */
export interface AddTokenOptions {
  /** Full token name including prefix (e.g., "--mybrowser-widget-dot-size") */
  tokenName: string;
  /** CSS value (e.g., "1px", "var(--space-small)", "light-dark(#fff, #000)") */
  value: string;
  /** Token category matching section headers in the CSS file */
  category: string;
  /** Dark mode behavior */
  mode: TokenMode;
  /** Comment description for the CSS file */
  description?: string | undefined;
  /** Dark mode value (required if mode is "override") */
  darkValue?: string | undefined;
  /** Dry run mode */
  dryRun?: boolean | undefined;
}

/**
 * Result of adding a token.
 */
export interface AddTokenResult {
  /** Whether the token was added to CSS */
  cssAdded: boolean;
  /** Whether the token was added to the docs table */
  docsAdded: boolean;
  /** Whether it was added to the unmapped table */
  unmappedAdded: boolean;
  /** Whether the count table was updated */
  countUpdated: boolean;
  /** Whether the operation was skipped (already exists) */
  skipped: boolean;
}

interface TokenAddContext {
  engineDir: string;
  tokensCssPath: string;
}

/** Returns the token CSS path relative to engine root for a given binary name. */
export function getTokensCssPath(binaryName: string): string {
  return `browser/themes/shared/${binaryName}-tokens.css`;
}

const TOKENS_DOC = 'docs/design/SRC_TOKENS.md';

/**
 * Determines the mode annotation string for the CSS comment.
 */
function getModeAnnotation(mode: TokenMode, value: string): string {
  if (mode === 'override') return 'override';
  if (mode === 'auto') {
    if (value.includes('light-dark(')) return 'auto (light-dark)';
    return 'auto';
  }
  // static
  if (value.startsWith('var(--')) return 'static';
  return 'static, fork-specific';
}

async function resolveTokenAddContext(root: string): Promise<TokenAddContext> {
  const { engine: engineDir } = getProjectPaths(root);
  const forgeConfig = await loadConfig(root);

  return {
    engineDir,
    tokensCssPath: getTokensCssPath(forgeConfig.binaryName),
  };
}

async function validateTokenPrefix(root: string, options: AddTokenOptions): Promise<void> {
  try {
    const config = await loadFurnaceConfig(root);
    if (config.tokenPrefix && !options.tokenName.startsWith(config.tokenPrefix)) {
      throw new InvalidArgumentError(
        `Token name "${options.tokenName}" does not match the configured prefix "${config.tokenPrefix}".`,
        'tokenName'
      );
    }
  } catch (error: unknown) {
    if (error instanceof InvalidArgumentError) throw error;
    // FurnaceError means furnace.json doesn't exist yet — skip silently.
    // Other errors (parse errors, permission errors) deserve a warning.
    if (!(error instanceof FurnaceError)) {
      const message = toError(error).message;
      warn(`Skipping token prefix validation: ${message}`);
    }
  }
}

function validateTokenNameSyntax(tokenName: string): void {
  const error = validateTokenName(tokenName);
  if (error) {
    throw new InvalidArgumentError(error, 'tokenName');
  }
}

function validateDarkValue(options: AddTokenOptions): void {
  if (options.mode === 'override' && !options.darkValue) {
    throw new InvalidArgumentError(
      'Override mode requires --dark-value to be specified.',
      'darkValue'
    );
  }
}

async function assertTokenCategoryExists(
  engineDir: string,
  tokensCssPath: string,
  category: string
): Promise<void> {
  const filePath = join(engineDir, tokensCssPath);

  if (!(await pathExists(filePath))) {
    throw new GeneralError(`Token CSS file not found: ${tokensCssPath}`);
  }

  const content = await readText(filePath);
  const lines = content.split('\n');
  const escapedCategory = escapeRegex(category);
  const singleLinePattern = new RegExp(`\\/\\*\\s*=.*${escapedCategory}.*=\\s*\\*\\/`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (singleLinePattern.test(line)) {
      return;
    }

    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (new RegExp(escapedCategory).test(blockLine)) {
          return;
        }
        if (/\*\//.test(blockLine)) break;
      }
    }
  }

  const discoveredCategories = discoverCategoryHeaders(lines);
  const available =
    discoveredCategories.length > 0
      ? `Available categories in the file: ${discoveredCategories.map((name) => `"${name}"`).join(', ')}.`
      : 'The file currently has no category headers. Add one by hand near the top of the :root { … } block — the format is "/* = My Category = */" — or run "fireforge furnace init --force" to re-scaffold the default seed set.';

  throw new GeneralError(
    `Category "${category}" not found in ${tokensCssPath}.\n\n` +
      `${available}\n\n` +
      'Categories are declared by comment headers. Single-line shape: /* = My Category = */. ' +
      'Multi-line shape: /* =============\\n * My Category\\n * ============= */.'
  );
}

/**
 * Scans a tokens CSS file for category header comments and returns the
 * category names in document order. Used to enrich the "category not
 * found" error body with concrete alternatives the operator can copy.
 *
 * Mirrors the shapes `findCategorySection` already recognises:
 * - Single-line: `/* = Foo = *\/`
 * - Multi-line: `/* =====` opening, `Foo` on any of the next ~5 lines,
 *   closing `*\/`.
 *
 * This helper exists as a pure inspector; it never throws on malformed
 * headers and silently skips shapes it cannot parse.
 */
function discoverCategoryHeaders(lines: string[]): string[] {
  const categories = new Set<string>();
  const singleLinePattern = /\/\*\s*=+\s*(.+?)\s*=+\s*\*\//;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const singleMatch = singleLinePattern.exec(line);
    if (singleMatch?.[1]) {
      const extracted = singleMatch[1].trim();
      if (extracted.length > 0) categories.add(extracted);
      continue;
    }

    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (/\*\//.test(blockLine)) break;
        const trimmed = blockLine.replace(/^\s*\*\s*/, '').trim();
        if (trimmed.length === 0) continue;
        if (/^=+$/.test(trimmed)) continue;
        categories.add(trimmed);
        break;
      }
    }
  }

  return [...categories];
}

/**
 * Validates token-add inputs without mutating files.
 *
 * @param root - Project root directory
 * @param options - Token options
 */
export async function validateTokenAdd(root: string, options: AddTokenOptions): Promise<void> {
  const { engineDir, tokensCssPath } = await resolveTokenAddContext(root);
  validateTokenNameSyntax(options.tokenName);
  await validateTokenPrefix(root, options);
  validateDarkValue(options);
  await assertTokenCategoryExists(engineDir, tokensCssPath, options.category);
}

/**
 * Adds a design token to the CSS file and documentation.
 *
 * @param root - Project root directory
 * @param options - Token options
 * @returns Result of the operation
 */
export async function addToken(root: string, options: AddTokenOptions): Promise<AddTokenResult> {
  const { engineDir, tokensCssPath } = await resolveTokenAddContext(root);
  validateTokenNameSyntax(options.tokenName);
  await validateTokenPrefix(root, options);
  validateDarkValue(options);

  if (options.dryRun) {
    await validateTokenAdd(root, options);

    const filePath = join(engineDir, tokensCssPath);
    const content = await readText(filePath);
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
    const skipped = stripped.includes(options.tokenName + ':');

    return {
      cssAdded: !skipped,
      docsAdded: !skipped,
      unmappedAdded: !skipped && !options.value.startsWith('var('),
      countUpdated: !skipped,
      skipped,
    };
  }

  // --- CSS file ---
  const cssAdded = await addTokenToCSS(engineDir, options, tokensCssPath);

  if (!cssAdded) {
    return {
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
    };
  }

  // --- Documentation ---
  const docsResult = await addTokenToDocs(engineDir, options);

  return {
    cssAdded,
    docsAdded: docsResult.docsAdded,
    unmappedAdded: docsResult.unmappedAdded,
    countUpdated: docsResult.countUpdated,
    skipped: false,
  };
}

function findCategorySection(
  lines: string[],
  category: string,
  tokensCssPath: string
): { categoryLine: number; sectionEnd: number } {
  const escapedCategory = escapeRegex(category);
  const singleLinePattern = new RegExp(`\\/\\*\\s*=.*${escapedCategory}.*=\\s*\\*\\/`);

  let categoryLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Check single-line format: /* = Category = */
    if (singleLinePattern.test(line)) {
      categoryLine = i;
      break;
    }

    // Check multi-line format: line opens a block comment with === but does NOT close it
    // e.g., "/* ================================================================"
    // (NOT "/* ================================================= */" which closes on the same line)
    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      // Look ahead within the comment block (up to 5 lines) for the category text
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (new RegExp(escapedCategory).test(blockLine)) {
          categoryLine = i;
          break;
        }
        // Stop if we've exited the comment block
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
  // Handles both single-line (/* =...= */) and multi-line (/* ===...) section delimiters
  // Skip past the current header block first
  let scanStart = categoryLine + 1;
  for (let i = categoryLine + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Skip lines that are part of the current header comment block
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
      /\/\*\s*=.*=\s*\*\//.test(line) ||
      (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) ||
      /^\s*\}/.test(line)
    ) {
      sectionEnd = i;
      break;
    }
  }

  return { categoryLine, sectionEnd };
}

function insertDarkModeOverride(lines: string[], options: AddTokenOptions): void {
  if (options.mode !== 'override' || !options.darkValue) return;

  const insertionIndex = findDarkRootInsertionIndex(lines);
  if (insertionIndex === null) return; // No @media block at all.

  const darkEntry = `    ${options.tokenName}: ${options.darkValue};`;

  if (insertionIndex === -1) {
    // @media block exists but has no nested :root { } — the scaffold
    // drifted. Warn and fall back to appending a fresh nested :root
    // block right before the @media block's closing brace so the
    // generated CSS still parses, rather than dropping the dark value
    // on the floor or producing a declaration outside any rule.
    warn(
      `Dark-mode override block for "${options.tokenName}" could not find a nested ":root { }" inside @media (prefers-color-scheme: dark). Appending a fresh ":root { }" block — review the tokens CSS scaffold.`
    );
    const outerCloseIndex = findDarkMediaCloseIndex(lines);
    if (outerCloseIndex === -1) return;
    lines.splice(outerCloseIndex, 0, '  :root {', darkEntry, '  }');
    return;
  }

  lines.splice(insertionIndex, 0, darkEntry);
}

/**
 * Adds a token declaration to the CSS file in the correct category section.
 */
async function addTokenToCSS(
  engineDir: string,
  options: AddTokenOptions,
  tokensCssPath: string
): Promise<boolean> {
  const filePath = join(engineDir, tokensCssPath);
  await assertTokenCategoryExists(engineDir, tokensCssPath, options.category);

  let content = await readText(filePath);

  // Idempotency check — strip CSS block comments so we don't match inside them
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  if (stripped.includes(options.tokenName + ':')) {
    return false;
  }

  const lines = content.split('\n');
  const annotation = getModeAnnotation(options.mode, options.value);

  const { categoryLine, sectionEnd } = findCategorySection(lines, options.category, tokensCssPath);

  // Build the insertion lines
  const insertLines: string[] = [];
  if (options.description) {
    insertLines.push(`  /* ${options.description} */`);
  }
  insertLines.push(`  ${options.tokenName}: ${options.value}; /* ${annotation} */`);

  // Insert before the section end (before next header or closing brace)
  // Find last non-blank line in the section to insert after it
  let insertIndex = sectionEnd;
  for (let i = sectionEnd - 1; i > categoryLine; i--) {
    if ((lines[i] ?? '').trim()) {
      insertIndex = i + 1;
      break;
    }
  }

  lines.splice(insertIndex, 0, ...insertLines);

  insertDarkModeOverride(lines, options);

  content = lines.join('\n');
  await writeText(filePath, content);
  return true;
}

/**
 * Strips surrounding backticks from a cell, if present. Token cells are
 * usually wrapped in inline code fences (`` `--foo` ``) and the parser
 * returns them verbatim.
 */
function stripInlineCode(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Adds a token row to the main token table, the unmapped table (for
 * literal values), and bumps the mode count table. Each sub-update runs
 * against a freshly parsed view of the document so that splice indices
 * stay valid as rewrites are layered.
 *
 * The old implementation walked `split('\n')` by hand, detected rows by
 * literal `|`-prefix, and used a whitespace-sensitive regex to increment
 * the mode count. Switching to {@link findTableByColumns} and
 * {@link updateCellByKey} removes those formatting traps.
 */
async function addTokenToDocs(
  engineDir: string,
  options: AddTokenOptions
): Promise<{ docsAdded: boolean; unmappedAdded: boolean; countUpdated: boolean }> {
  const filePath = join(engineDir, '..', TOKENS_DOC);

  if (!(await pathExists(filePath))) {
    // Docs file is optional
    return { docsAdded: false, unmappedAdded: false, countUpdated: false };
  }

  const originalContent = await readText(filePath);
  let lines = originalContent.split('\n');

  let docsAdded = false;
  let unmappedAdded = false;
  let countUpdated = false;

  const annotation = getModeAnnotation(options.mode, options.value);
  const isLiteral = !options.value.startsWith('var(');
  const mapsTo = isLiteral ? '—' : options.value.replace(/var\(([^)]+)\)/, '$1');
  const tokenCell = `\`${options.tokenName}\``;
  const valueCell = `\`${options.value}\``;

  // --- Main token table: Category | Token | Value | Maps to | Mode ---
  const mainTable = findTableByColumns(lines, ['Category', 'Token', 'Value', 'Mode']);
  if (mainTable) {
    // The doc convention allows the Category cell to be blank on
    // continuation rows that belong to the previous category. Group rows
    // by carrying the last non-empty Category value forward.
    let lastGroupRowIndex = -1;
    let currentCategory = '';
    for (let i = 0; i < mainTable.rows.length; i++) {
      const row = mainTable.rows[i];
      if (!row) continue;
      const cell = row[0]?.trim() ?? '';
      if (cell) {
        currentCategory = cell;
      }
      if (currentCategory === options.category) {
        lastGroupRowIndex = i;
      }
    }

    if (lastGroupRowIndex !== -1) {
      insertRow(mainTable, ['', tokenCell, valueCell, mapsTo, annotation], lastGroupRowIndex + 1);
      lines = rewriteTableRows(lines, mainTable);
      docsAdded = true;
    }
  }

  // --- Unmapped table: populated for literal (non-var()) values only ---
  if (isLiteral) {
    const unmappedTable = findTableAfterHeading(lines, /not yet mapped|unmapped/i);
    if (unmappedTable) {
      insertRow(
        unmappedTable,
        [tokenCell, valueCell, options.description ?? ''],
        unmappedTable.rows.length
      );
      lines = rewriteTableRows(lines, unmappedTable);
      unmappedAdded = true;
    }
  }

  // --- Mode behavior count table: Mode | Count ---
  const modeTable = findTableByColumns(lines, ['Mode', 'Count']);
  if (modeTable) {
    const modeIndex = modeTable.headers.indexOf('Mode');
    const countIndex = modeTable.headers.indexOf('Count');
    const existing = modeTable.rows.find(
      (row) => stripInlineCode(row[modeIndex] ?? '') === options.mode
    );
    if (existing) {
      const oldCount = parseInt(existing[countIndex] ?? '0', 10);
      const updated = updateCellByKey(
        modeTable,
        'Mode',
        existing[modeIndex] ?? options.mode,
        'Count',
        String((Number.isNaN(oldCount) ? 0 : oldCount) + 1)
      );
      if (updated) {
        lines = rewriteTableRows(lines, modeTable);
        countUpdated = true;
      }
    }
  }

  await writeText(filePath, lines.join('\n'));

  return { docsAdded, unmappedAdded, countUpdated };
}
