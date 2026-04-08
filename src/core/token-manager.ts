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

  throw new GeneralError(
    `Category "${category}" not found in ${tokensCssPath}. ` +
      'Available categories are defined by /* =... category ...= */ comment headers.'
  );
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
    throw new GeneralError(
      `Category "${category}" not found in ${tokensCssPath}. ` +
        'Available categories are defined by /* =... category ...= */ comment headers.'
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

  let darkMediaLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/prefers-color-scheme:\s*dark/.test(lines[i] ?? '')) {
      darkMediaLine = i;
      break;
    }
  }

  if (darkMediaLine === -1) return;

  // Find the closing } of the @media block
  let darkBlockEnd = lines.length;
  let depth = 0;
  let entryDepth = 0;
  let enteredBlock = false;
  for (let i = darkMediaLine; i < lines.length; i++) {
    const line = lines[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (!enteredBlock) {
          entryDepth = depth - 1;
          enteredBlock = true;
        }
      }
      if (ch === '}') depth--;
    }
    if (enteredBlock && depth === entryDepth) {
      darkBlockEnd = i;
      break;
    }
  }

  // Insert the dark value before the closing }
  const darkEntry = `    ${options.tokenName}: ${options.darkValue};`;
  lines.splice(darkBlockEnd, 0, darkEntry);
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
 * Adds a token to the documentation markdown file.
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

  let content = await readText(filePath);
  const lines = content.split('\n');

  let docsAdded = false;
  let unmappedAdded = false;
  let countUpdated = false;

  const annotation = getModeAnnotation(options.mode, options.value);
  const isLiteral = !options.value.startsWith('var(');

  // Find the category group in the token table
  // Look for a row containing the category name, then find the last row in that group
  let categoryRowStart = -1;
  let lastRowInCategory = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    // Table rows start with |
    if (line.startsWith('|') && line.includes(options.category)) {
      categoryRowStart = i;
      lastRowInCategory = i;
    } else if (
      categoryRowStart !== -1 &&
      line.startsWith('|') &&
      !line.startsWith('|--') &&
      !line.startsWith('| Token')
    ) {
      // Check if this row still belongs to the same category (no category cell or empty category)
      const cells = line.split('|').map((c) => c.trim());
      // If the first data cell (after leading empty) is empty, it belongs to same category
      if (cells[1] === '' || !cells[1]) {
        lastRowInCategory = i;
      } else {
        break;
      }
    } else if (categoryRowStart !== -1 && !line.startsWith('|')) {
      break;
    }
  }

  if (lastRowInCategory !== -1) {
    // Insert a new row after the last row in this category
    const mapsTo = isLiteral ? '—' : options.value.replace(/var\(([^)]+)\)/, '$1');
    const newRow = `| | \`${options.tokenName}\` | \`${options.value}\` | ${mapsTo} | ${annotation} |`;
    lines.splice(lastRowInCategory + 1, 0, newRow);
    docsAdded = true;
  }

  // If the value is a literal (not a var() reference), add to unmapped table
  if (isLiteral) {
    let unmappedTableStart = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? '';
      if (/not yet mapped/i.test(line) || /unmapped/i.test(line)) {
        unmappedTableStart = i;
        break;
      }
    }

    if (unmappedTableStart !== -1) {
      // Find the last row of the unmapped table
      let lastUnmappedRow = unmappedTableStart;
      for (let i = unmappedTableStart + 1; i < lines.length; i++) {
        const line = lines[i] ?? '';
        if (line.startsWith('|') && !line.startsWith('|--') && !line.startsWith('| Token')) {
          lastUnmappedRow = i;
        } else if (!line.startsWith('|')) {
          break;
        }
      }

      const unmappedRow = `| \`${options.tokenName}\` | \`${options.value}\` | ${options.description ?? ''} |`;
      lines.splice(lastUnmappedRow + 1, 0, unmappedRow);
      unmappedAdded = true;
    }
  }

  // Update dark/light mode behavior count table
  const modeCountPattern = new RegExp(`\\|\\s*${options.mode}\\s*\\|\\s*(\\d+)\\s*\\|`);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const match = modeCountPattern.exec(line);
    if (match) {
      const oldCount = parseInt(match[1] ?? '0', 10);
      lines[i] = line.replace(modeCountPattern, `| ${options.mode} | ${oldCount + 1} |`);
      countUpdated = true;
      break;
    }
  }

  content = lines.join('\n');
  await writeText(filePath, content);

  return { docsAdded, unmappedAdded, countUpdated };
}
