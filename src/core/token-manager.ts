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
import { findDarkMediaCloseIndex, findDarkRootInsertionIndex } from './token-dark-mode.js';
import { addTokenToDocs } from './token-docs.js';
import {
  insertVariantDeclaration,
  validateVariantSelector,
  variantBlockHasToken,
} from './token-variant.js';

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
  /** Declare the category banner in the tokens CSS when it does not exist yet. */
  createCategory?: boolean | undefined;
  /**
   * Attribute selector fragment (e.g. `[data-skin="precision"]` or
   * `[data-private]`) that routes the declaration into a top-level
   * `:root<variant>` block instead of the base `:root` / category section.
   * The block is created if absent and appended to if present. Variant
   * overrides are CSS-only — the base token already owns its docs row.
   */
  variant?: string | undefined;
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
  /** Whether a new category banner was declared by this add. */
  categoryCreated?: boolean;
}

interface TokenAddContext {
  engineDir: string;
  tokensCssPath: string;
}

/** Returns the token CSS path relative to engine root for a given binary name. */
export function getTokensCssPath(binaryName: string): string {
  return `browser/themes/shared/${binaryName}-tokens.css`;
}

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

/**
 * Validates and normalizes the `--variant` attribute selector. Returns the
 * normalized (quoted) selector when set, or `undefined` when no variant was
 * requested. Rejects combining `--variant` with `--mode override`: an
 * override authors a dark `@media :root` block, which variant routing
 * bypasses, so the combination would silently drop the dark value.
 */
function normalizeVariantOption(options: AddTokenOptions): string | undefined {
  if (options.variant === undefined) return undefined;
  if (options.mode === 'override') {
    throw new InvalidArgumentError(
      'Cannot combine --variant with --mode override; author the variant declaration with ' +
        '--mode auto/static instead.',
      'variant'
    );
  }
  const result = validateVariantSelector(options.variant);
  if (!result.ok) {
    throw new InvalidArgumentError(`--variant ${result.reason}.`, 'variant');
  }
  return result.value;
}

/** Throws when the tokens CSS file is missing (variant mode skips category checks). */
async function assertTokensCssExists(engineDir: string, tokensCssPath: string): Promise<void> {
  if (!(await pathExists(join(engineDir, tokensCssPath)))) {
    throw new GeneralError(`Token CSS file not found: ${tokensCssPath}`);
  }
}

/**
 * Routes a declaration into the top-level `:root<variant>` block — creating
 * the block after the base `:root` block if absent, or appending to it if
 * present. Idempotent within the block. Returns `{ added: false }` when the
 * token already lives in that block.
 */
async function addVariantTokenToCSS(
  engineDir: string,
  options: AddTokenOptions,
  tokensCssPath: string,
  variant: string
): Promise<{ added: boolean }> {
  await assertTokensCssExists(engineDir, tokensCssPath);
  const filePath = join(engineDir, tokensCssPath);
  const lines = (await readText(filePath)).split('\n');
  if (variantBlockHasToken(lines, variant, options.tokenName)) return { added: false };

  const annotation = getModeAnnotation(options.mode, options.value);
  insertVariantDeclaration(
    lines,
    variant,
    `  ${options.tokenName}: ${options.value}; /* ${annotation} */`
  );
  await writeText(filePath, lines.join('\n'));
  return { added: true };
}

/**
 * True when `lines` contain a category header (single-line or multi-line
 * banner shape) naming `category`. Shared by the pre-add assertion and the
 * in-memory banner creation path so both agree on what "exists" means.
 */
function categoryHeaderExists(lines: string[], category: string): boolean {
  const escapedCategory = escapeRegex(category);
  const singleLinePattern = new RegExp(`\\/\\*\\s*=.*${escapedCategory}.*=\\s*\\*\\/`);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (singleLinePattern.test(line)) {
      return true;
    }

    if (/^\s*\/\*\s*=+/.test(line) && !/\*\//.test(line)) {
      for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
        const blockLine = lines[j] ?? '';
        if (new RegExp(escapedCategory).test(blockLine)) {
          return true;
        }
        if (/\*\//.test(blockLine)) break;
      }
    }
  }
  return false;
}

async function assertTokenCategoryExists(
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
  // Variant mode targets a `:root<attr>` block, not a category section, so it
  // only needs the tokens CSS file to exist — category checks do not apply.
  if (normalizeVariantOption(options) !== undefined) {
    await assertTokensCssExists(engineDir, tokensCssPath);
    return;
  }
  await assertTokenCategoryExists(
    engineDir,
    tokensCssPath,
    options.category,
    options.createCategory === true
  );
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
  const normalizedVariant = normalizeVariantOption(options);

  if (options.dryRun) {
    await validateTokenAdd(root, options);

    const filePath = join(engineDir, tokensCssPath);
    const content = await readText(filePath);
    if (normalizedVariant !== undefined) {
      const skipped = variantBlockHasToken(
        content.split('\n'),
        normalizedVariant,
        options.tokenName
      );
      return {
        cssAdded: !skipped,
        docsAdded: false,
        unmappedAdded: false,
        countUpdated: false,
        skipped,
      };
    }
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

  // Variant overrides are CSS-only: route the declaration into the
  // `:root<attr>` block and leave docs untouched (the base token owns its
  // docs row). Done before the base-CSS path so an override of an existing
  // base token is not short-circuited by the global idempotency check.
  if (normalizedVariant !== undefined) {
    const { added } = await addVariantTokenToCSS(
      engineDir,
      options,
      tokensCssPath,
      normalizedVariant
    );
    return {
      cssAdded: added,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: !added,
    };
  }

  // --- CSS file ---
  const { added: cssAdded, categoryCreated } = await addTokenToCSS(
    engineDir,
    options,
    tokensCssPath
  );

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
  const docsResult = await addTokenToDocs(
    engineDir,
    options,
    getModeAnnotation(options.mode, options.value)
  );

  return {
    cssAdded,
    docsAdded: docsResult.docsAdded,
    unmappedAdded: docsResult.unmappedAdded,
    countUpdated: docsResult.countUpdated,
    skipped: false,
    categoryCreated,
  };
}

/**
 * Splices a new single-line category banner ("= Name =" comment shape, the
 * same format `discoverCategoryHeaders` recognises) just before the closing
 * brace of the `:root` block, making the new category the last section.
 * Mutates `lines` in place.
 */
function declareCategoryBanner(lines: string[], category: string, tokensCssPath: string): void {
  let rootOpen = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/:root\s*\{/.test(lines[i] ?? '')) {
      rootOpen = i;
      break;
    }
  }
  if (rootOpen === -1) {
    throw new GeneralError(
      `Cannot create category "${category}": no :root block found in ${tokensCssPath}. ` +
        'Run "fireforge furnace init --force" to re-scaffold the tokens CSS file.'
    );
  }
  let rootClose = -1;
  for (let i = rootOpen + 1; i < lines.length; i++) {
    if (/^\s*\}/.test(lines[i] ?? '')) {
      rootClose = i;
      break;
    }
  }
  if (rootClose === -1) {
    throw new GeneralError(
      `Cannot create category "${category}": the :root block in ${tokensCssPath} never closes.`
    );
  }
  lines.splice(rootClose, 0, '', `  /* = ${category} = */`);
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
): Promise<{ added: boolean; categoryCreated: boolean }> {
  const filePath = join(engineDir, tokensCssPath);
  await assertTokenCategoryExists(
    engineDir,
    tokensCssPath,
    options.category,
    options.createCategory === true
  );

  let content = await readText(filePath);

  // Idempotency check — strip CSS block comments so we don't match inside them
  const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '');
  if (stripped.includes(options.tokenName + ':')) {
    return { added: false, categoryCreated: false };
  }

  const lines = content.split('\n');
  const annotation = getModeAnnotation(options.mode, options.value);

  // Declare a missing category banner in the same in-memory edit as the
  // token insertion — the file is written exactly once, so a failure
  // between "banner declared" and "token inserted" cannot occur.
  let categoryCreated = false;
  if (options.createCategory === true && !categoryHeaderExists(lines, options.category)) {
    declareCategoryBanner(lines, options.category, tokensCssPath);
    categoryCreated = true;
  }

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
  return { added: true, categoryCreated };
}
