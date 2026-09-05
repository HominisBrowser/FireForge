// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { FurnaceError } from '../errors/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText, writeText } from '../utils/fs.js';
import { info, warn } from '../utils/logger.js';
import { describeTokenNameProblem, makeEnumGuard } from '../utils/validation.js';
import { getProjectPaths, loadConfig } from './config.js';
import { loadFurnaceConfig } from './furnace-config.js';
import {
  assertTokenCategoryExists,
  categoryHeaderExists,
  declareCategoryBanner,
  findCategorySection,
  findTokenDeclarationInRoot,
  type TokenDeclarationLocation,
} from './token-category.js';
import { findDarkMediaCloseIndex, findDarkRootInsertionIndex } from './token-dark-mode.js';
import { addTokenToDocs } from './token-docs.js';
import {
  findVariantBlockDeclaration,
  insertVariantDeclaration,
  validateVariantSelector,
  variantBlockExists,
  variantBlockHasToken,
  variantBlockQualifier,
} from './token-variant.js';

/**
 * Dark mode behaviour for a token.
 *
 * Derived from {@link TOKEN_MODES} so the runtime allowlist and the type
 * cannot drift: adding a member here without updating the list (or the
 * reverse) is no longer possible, because there is only one list.
 */
export const TOKEN_MODES = ['auto', 'static', 'override'] as const;

/** Dark mode behaviour for a token. */
export type TokenMode = (typeof TOKEN_MODES)[number];

/** Narrows an arbitrary string to a {@link TokenMode}. */
export const isTokenMode = makeEnumGuard(TOKEN_MODES);

/**
 * Options for adding a token.
 */
export interface AddTokenOptions {
  /** Full token name including prefix (e.g., "--mybrowser-widget-dot-size") */
  tokenName: string;
  /** CSS value (e.g., "1px", "var(--space-small)", "light-dark(#fff, #000)") */
  value: string;
  /**
   * Token category matching section headers in the CSS file. Required for a
   * base declaration. Ignored, and no longer required, under
   * {@link AddTokenOptions.variant}, which routes into a `:root<selector>`
   * block and never touches a category section.
   */
  category?: string | undefined;
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
   * overrides are CSS-only. The base token already owns its docs row.
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
  /**
   * When the add skipped because the token already lives in the target
   * category, names where the existing base-`:root` declaration sits so
   * the skip message can point at it.
   */
  skippedExisting?: TokenDeclarationLocation;
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
    // FurnaceError means furnace.json doesn't exist yet, so skip silently.
    // Other errors (parse errors, permission errors) deserve a warning.
    if (!(error instanceof FurnaceError)) {
      const message = toError(error).message;
      warn(`Skipping token prefix validation: ${message}`);
    }
  }
}

function validateTokenNameSyntax(tokenName: string): void {
  const error = describeTokenNameProblem(tokenName);
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
  if (options.createCategory === true) {
    throw new InvalidArgumentError(
      '--create-category cannot be combined with --variant; variant declarations are routed ' +
        'into a :root<selector> block, not a category section. Add the BASE token first ' +
        '(with --create-category) to author the category, then add each variant with ' +
        '--variant.',
      'variant'
    );
  }
  const result = validateVariantSelector(options.variant);
  if (!result.ok) {
    throw new InvalidArgumentError(`--variant ${result.reason}.`, 'variant');
  }
  return result.value;
}

/**
 * Narrows {@link AddTokenOptions.category} for the base-declaration path,
 * which cannot proceed without one.
 *
 * `--category` used to be unconditionally required, including under
 * `--variant`, where the declaration is routed into a `:root<selector>`
 * block and the category names nothing about where the token lands. The
 * requirement existed so the argument would not be silently discarded,
 * a fair goal that produced a mandatory argument describing nothing. Under
 * a variant it is now optional. Everywhere else this states the reason
 * rather than leaving commander to print a bare "required option not
 * specified".
 *
 * @param options - Token options
 * @returns The category
 */
function requireCategory(options: AddTokenOptions): string {
  if (options.category === undefined || options.category.trim() === '') {
    throw new InvalidArgumentError(
      'A base token declaration lands in a category section, so --category is required. ' +
        'Pass --variant <selector> instead if this declaration belongs in a ' +
        ':root<selector> block, where no category applies.',
      'category'
    );
  }
  return options.category;
}

/** Throws when the tokens CSS file is missing (variant mode skips category checks). */
async function assertTokensCssExists(engineDir: string, tokensCssPath: string): Promise<void> {
  if (!(await pathExists(join(engineDir, tokensCssPath)))) {
    throw new GeneralError(`Token CSS file not found: ${tokensCssPath}`);
  }
}

/**
 * Routes a declaration into the top-level `:root<variant>` block, creating
 * the block after the base `:root` block if absent, or appending to it if
 * present. Idempotent within the block.
 *
 * A skip carries the location of the existing declaration, mirroring
 * {@link evaluateBaseTokenIdempotency}. The bare `{ added: false }` it used
 * to return told the caller nothing, so a re-run intending to change a
 * value exited 0 having changed nothing and said only "already exists",
 * while the base path had reported the category and line for the same
 * situation all along.
 */
async function addVariantTokenToCSS(
  engineDir: string,
  options: AddTokenOptions,
  tokensCssPath: string,
  variant: string
): Promise<{ added: boolean; existing?: TokenDeclarationLocation }> {
  await assertTokensCssExists(engineDir, tokensCssPath);
  const filePath = join(engineDir, tokensCssPath);
  const lines = (await readText(filePath)).split('\n');
  const declared = findVariantBlockDeclaration(lines, variant, options.tokenName);
  if (declared !== undefined) return { added: false, existing: declared };

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
 * Evaluates base-`:root` idempotency for one add: a token already declared
 * in the target category skips. A token declared anywhere else in the base
 * block refuses loud. A whole-file substring check instead skips silently,
 * discarding `--create-category`, and exits 0.
 */
function evaluateBaseTokenIdempotency(
  lines: string[],
  options: AddTokenOptions,
  tokensCssPath: string
): { skipped: boolean; existing?: TokenDeclarationLocation } {
  const existing = findTokenDeclarationInRoot(lines, options.tokenName);
  if (!existing) return { skipped: false };
  if (existing.category === options.category) {
    return { skipped: true, existing };
  }
  const sectionSuffix = existing.category === undefined ? '' : `, section "${existing.category}"`;
  const remedy =
    existing.category === undefined
      ? 'remove the stray declaration first'
      : `pass --category "${existing.category}" to target the existing declaration, or remove it first`;
  throw new GeneralError(
    `Token "${options.tokenName}" is already declared outside category "${options.category}" ` +
      `(${tokensCssPath}:${existing.line}${sectionSuffix}). ` +
      `A token belongs to exactly one category — ${remedy}.`
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
  // Variant mode targets a `:root<attr>` block, not a category section, so
  // no category is consulted, and none is required. When one is passed it
  // is still checked, so a typo'd category is not silently accepted just
  // because the flag happens to be inert here.
  if (normalizeVariantOption(options) !== undefined) {
    if (options.category !== undefined && options.category.trim() !== '') {
      await assertTokenCategoryExists(engineDir, tokensCssPath, options.category, false);
    }
    return;
  }
  await assertTokenCategoryExists(
    engineDir,
    tokensCssPath,
    requireCategory(options),
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
    const { skipped, existing } = evaluateBaseTokenIdempotency(
      content.split('\n'),
      options,
      tokensCssPath
    );

    return {
      cssAdded: !skipped,
      docsAdded: !skipped,
      unmappedAdded: !skipped && !options.value.startsWith('var('),
      countUpdated: !skipped,
      skipped,
      ...(existing !== undefined ? { skippedExisting: existing } : {}),
    };
  }

  // Variant overrides are CSS-only: route the declaration into the
  // `:root<attr>` block and leave docs untouched (the base token owns its
  // docs row). Done before the base-CSS path so an override of an existing
  // base token is not short-circuited by the global idempotency check.
  if (normalizedVariant !== undefined) {
    // A category is optional here and names nothing about where the
    // declaration lands, but a category that was passed is still verified.
    if (options.category !== undefined && options.category.trim() !== '') {
      await assertTokenCategoryExists(engineDir, tokensCssPath, options.category, false);
    }
    const { added, existing } = await addVariantTokenToCSS(
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
      ...(existing !== undefined ? { skippedExisting: existing } : {}),
    };
  }

  // --- CSS file ---
  const {
    added: cssAdded,
    categoryCreated,
    existing,
  } = await addTokenToCSS(engineDir, options, tokensCssPath);

  if (!cssAdded) {
    return {
      cssAdded: false,
      docsAdded: false,
      unmappedAdded: false,
      countUpdated: false,
      skipped: true,
      ...(existing !== undefined ? { skippedExisting: existing } : {}),
    };
  }

  // --- Documentation ---
  // Only the base path reaches here (variant declarations returned above),
  // so a category is guaranteed. `requireCategory` already ran inside
  // `addTokenToCSS`. Re-narrowing rather than asserting keeps the docs
  // input's required `category` honest.
  const docsResult = await addTokenToDocs(
    engineDir,
    { ...options, category: requireCategory(options) },
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
 * Explicit theme-attribute selectors the override path keeps in sync with
 * the `@media (prefers-color-scheme: dark)` block. Consumer scaffolds that
 * pair the media query with `:root[data-theme="dark"]` /
 * `:root[data-theme="light"]` blocks (viewer-toggle theming) require every
 * themed list to declare identical token sets, so an override add that only
 * wrote the media block would be a guaranteed half-finished edit.
 */
const THEME_ATTRIBUTE_VARIANTS = [
  { variant: '[data-theme="dark"]', pick: 'dark' },
  { variant: '[data-theme="light"]', pick: 'light' },
] as const;

/**
 * Mirrors an override's light/dark values into existing top-level
 * `:root[data-theme="dark"]` / `:root[data-theme="light"]` blocks. Blocks
 * that do not exist are left alone (scaffolded files have none, so behavior
 * is unchanged there). Idempotent per block. Returns the selectors written.
 */
function insertThemeAttributeOverrides(lines: string[], options: AddTokenOptions): string[] {
  if (options.mode !== 'override' || !options.darkValue) return [];

  const written: string[] = [];
  for (const { variant, pick } of THEME_ATTRIBUTE_VARIANTS) {
    if (!variantBlockExists(lines, variant)) continue;
    if (variantBlockHasToken(lines, variant, options.tokenName)) continue;
    const value = pick === 'dark' ? options.darkValue : options.value;
    insertVariantDeclaration(lines, variant, `  ${options.tokenName}: ${value};`);
    written.push(`:root${variant}`);

    // A qualified block is matched. Skipping it is the worse failure, and
    // the one that shipped, but the qualifier narrows where the token
    // applies, so say which selector was written through rather than
    // letting the operator meet the narrowing as a theme bug later.
    const qualifier = variantBlockQualifier(lines, variant);
    if (qualifier !== undefined && qualifier.length > 0) {
      warn(
        `Wrote ${options.tokenName} into the qualified block ":root${variant}${qualifier}". ` +
          `The "${qualifier}" qualifier narrows where this override applies; ` +
          'add an unqualified block if it should apply to every case.'
      );
    }
  }
  return written;
}

function insertDarkModeOverride(lines: string[], options: AddTokenOptions): void {
  if (options.mode !== 'override' || !options.darkValue) return;

  const insertionIndex = findDarkRootInsertionIndex(lines);
  if (insertionIndex === null) return; // No @media block at all.

  const darkEntry = `    ${options.tokenName}: ${options.darkValue};`;

  if (insertionIndex === -1) {
    // @media block exists but has no nested :root { }, so the scaffold
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
): Promise<{ added: boolean; categoryCreated: boolean; existing?: TokenDeclarationLocation }> {
  const filePath = join(engineDir, tokensCssPath);
  const category = requireCategory(options);
  await assertTokenCategoryExists(
    engineDir,
    tokensCssPath,
    category,
    options.createCategory === true
  );

  const content = await readText(filePath);
  const lines = content.split('\n');

  // Per-category idempotency: a declaration in the target
  // category skips. A declaration elsewhere in the base :root block
  // throws instead of silently skipping (and silently discarding
  // --create-category).
  const idempotency = evaluateBaseTokenIdempotency(lines, options, tokensCssPath);
  if (idempotency.skipped) {
    return {
      added: false,
      categoryCreated: false,
      ...(idempotency.existing !== undefined ? { existing: idempotency.existing } : {}),
    };
  }
  const annotation = getModeAnnotation(options.mode, options.value);

  // Declare a missing category banner in the same in-memory edit as the
  // token insertion. The file is written exactly once, so a failure
  // between "banner declared" and "token inserted" cannot occur.
  let categoryCreated = false;
  if (options.createCategory === true && !categoryHeaderExists(lines, category)) {
    declareCategoryBanner(lines, category, tokensCssPath);
    categoryCreated = true;
  }

  const { categoryLine, sectionEnd } = findCategorySection(lines, category, tokensCssPath);

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

  const themeBlocksWritten = insertThemeAttributeOverrides(lines, options);
  if (themeBlocksWritten.length > 0) {
    info(`Override also written to ${themeBlocksWritten.join(' and ')}.`);
  }

  await writeText(filePath, lines.join('\n'));
  return { added: true, categoryCreated };
}
