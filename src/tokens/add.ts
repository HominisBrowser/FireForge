// SPDX-License-Identifier: EUPL-1.2
/**
 * Adding a design token to the token file: a declaration in its category in
 * the base `:root` block and, for `override`, in the dark-mode and
 * theme-attribute blocks; or, with a variant, a declaration in the
 * `:root<variant>` block. Every function works on text.
 */
import { usageError } from '../cli/command.js';
import { FireForgeError } from '../kernel/errors.js';
import { type CssBlock, parseCss, type Stylesheet } from '../syntax/index.js';
import { appendToBlock, baseRoot, declarationsIn, isolateClose } from './css.js';
import { categories } from './model.js';

/** How a token behaves in dark mode: it follows the platform, never changes, or has its own dark value. */
export const TOKEN_MODES = ['auto', 'static', 'override'] as const;

/** One of {@link TOKEN_MODES}. */
export type TokenMode = (typeof TOKEN_MODES)[number];

/** A token to add. */
export interface AddTokenRequest {
  /** Custom property name, with `--`. */
  name: string;
  /** The CSS value. */
  value: string;
  mode: TokenMode;
  /** Category banner to add the token under; required unless `variant` is given. */
  category?: string | undefined;
  /** Comment written above the declaration. */
  description?: string | undefined;
  /** The dark value; required by, and only for, `override`. */
  darkValue?: string | undefined;
  /** Attribute selector fragment such as `[data-skin=precision]`: adds to the `:root<variant>` block instead. */
  variant?: string | undefined;
  /** Declare the category banner when the file has none by that name. */
  createCategory?: boolean | undefined;
}

/** The outcome of adding a token. */
export interface AddTokenResult {
  /** The file's new text (the input when nothing changed). */
  text: string;
  changed: boolean;
  /** The token was already declared; where. */
  existing?: { line: number; where: string };
  categoryCreated: boolean;
  /** Theme-attribute selectors an override was also written to. */
  mirrored: string[];
  /** Things to know about what was written. */
  notes: string[];
}

/**
 * The full custom property name for a name as typed. A bare name takes the
 * project's token prefix unless it already starts with it.
 *
 * @param raw - `--name` or a bare name
 * @param prefix - The project's token prefix (`--brand-`), if it has one
 * @throws `invalid-argument` for a name that cannot be written as a custom property
 */
export function tokenName(raw: string, prefix: string | undefined): string {
  const ident = raw.replace(/^--/, '');
  let problem: string | undefined;
  if (ident === '') problem = 'must not be empty';
  else if (/[\s\p{Cc}]/u.test(ident)) problem = 'must not contain whitespace or control characters';
  else if (!/^[-_a-zA-Z0-9\u0080-\u{10ffff}]+$/u.test(ident)) {
    problem = 'must use only letters, digits, hyphens and underscores';
  }
  if (problem !== undefined) throw usageError(`Token name "${raw}" ${problem}.`);
  if (raw.startsWith('--') || prefix === undefined) return `--${ident}`;
  const bare = prefix.replace(/^--/, '').replace(/-$/, '');
  return ident === bare || ident.startsWith(`${bare}-`) ? `--${ident}` : `--${bare}-${ident}`;
}

/** Why `text` cannot be one declaration's value, or undefined. */
function valueProblem(text: string): string | undefined {
  if (/[\r\n]/.test(text)) return 'must be a single line';
  let quote: string | undefined;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charAt(i);
    if (quote !== undefined) {
      if (char === '\\') i++;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth++;
    else if (char === ')') depth--;
    else if (char === '{' || char === '}') return `must not contain "${char}" outside a string`;
    else if (char === ';' && depth <= 0) return 'must not contain ";" outside a string or ()';
    else if (char === '/' && text.charAt(i + 1) === '*') return 'must not contain a comment';
    if (depth < 0) return 'has an unbalanced ")"';
  }
  if (quote !== undefined) return 'has an unterminated string';
  return depth === 0 ? undefined : 'has an unbalanced "("';
}

const ATTRIBUTE = String.raw`\[[a-zA-Z][\w-]*(?:=(?:"[\w-]+"|'[\w-]+'|[\w-]+))?\]`;
const VARIANT = new RegExp(`^(?:${ATTRIBUTE})+(?::[a-zA-Z][\\w-]*(?:\\((?:${ATTRIBUTE})+\\))?)?$`);

/**
 * Checks a variant selector fragment and writes its attribute values in the
 * quoted form: `[data-skin=x]` becomes `[data-skin="x"]`.
 */
function normalizeVariant(raw: string): string {
  const value = raw.trim();
  if (!VARIANT.test(value)) {
    throw usageError(
      `--variant "${raw}" must be attribute selectors such as [data-private] or [data-skin=precision], ` +
        'optionally followed by a pseudo-class such as :not([data-private]).'
    );
  }
  return value.replace(
    /=(?:'([\w-]+)'|([\w-]+))\]/g,
    (_all, quoted: string | undefined, bare: string | undefined) => `="${quoted ?? bare}"]`
  );
}

function checkRequest(request: AddTokenRequest): string | undefined {
  for (const [label, text] of [
    ['value', request.value],
    ['dark value', request.darkValue],
  ] as const) {
    const problem = text === undefined ? undefined : valueProblem(text);
    if (problem !== undefined) throw usageError(`Token ${label} "${text ?? ''}" ${problem}.`);
  }
  if (request.description !== undefined && /[\r\n]|\*\//.test(request.description)) {
    throw usageError('Token description must be one line without "*/".');
  }
  if (request.mode === 'override' && request.darkValue === undefined) {
    throw usageError('--mode override needs --dark-value.');
  }
  if (request.mode !== 'override' && request.darkValue !== undefined) {
    throw usageError('--dark-value applies to --mode override only.');
  }
  if (request.variant === undefined) {
    if (request.category === undefined || request.category.trim() === '') {
      throw usageError(
        'A token is declared in a category, so --category is required.',
        'Pass --variant <selector> to add to a :root<selector> block instead.'
      );
    }
    return undefined;
  }
  if (request.mode === 'override' || request.createCategory === true) {
    throw usageError(
      '--variant cannot be combined with --mode override or --create-category.',
      'Add the base token first, then add each variant.'
    );
  }
  return normalizeVariant(request.variant);
}

function annotation(mode: TokenMode, value: string): string {
  if (mode === 'override') return 'override';
  if (mode === 'auto') return value.includes('light-dark(') ? 'auto (light-dark)' : 'auto';
  return value.startsWith('var(--') ? 'static' : 'static, fork-specific';
}

function canonical(selector: string): string {
  return selector.replace(/\s+/g, '').replace(/["']/g, '');
}

function noTokenFile(): FireForgeError {
  return new FireForgeError(
    'token-file-invalid',
    'The token file has no :root block that closes.',
    {
      hint: 'Restore the :root block of the token file.',
    }
  );
}

/** The category name at a zero-based line, or undefined. */
function categoryAt(sheet: Stylesheet, line: number): string | undefined {
  return categories(sheet).find((section) => line > section.line && line < section.end)?.name;
}

function unknownCategory(sheet: Stylesheet, name: string): FireForgeError {
  const known = categories(sheet).map((section) => `"${section.name}"`);
  return new FireForgeError(
    'token-category-missing',
    `Category "${name}" not found in the token file.\n\n` +
      (known.length > 0
        ? `Categories: ${known.join(', ')}.`
        : 'The file has no category banners.') +
      '\n\nBanners are comments inside :root, such as /* = My Category = */. ' +
      'Pass --create-category to declare one.'
  );
}

/** The top-level `:root<attributes>` block whose attribute run is `variant`, with any qualifier when `anyQualifier`. */
function variantBlock(
  sheet: Stylesheet,
  variant: string,
  anyQualifier: boolean
): CssBlock | undefined {
  const wanted = canonical(`:root${variant}`);
  return sheet.blocks.find((block) => {
    if (block.parent !== undefined) return false;
    const own = canonical(block.selector);
    if (own === wanted) return true;
    if (!anyQualifier) return false;
    const attributes = /^:root(?:\[[^\]]+\])*/.exec(block.selector)?.[0];
    return attributes !== undefined && canonical(attributes) === wanted;
  });
}

function addVariant(text: string, request: AddTokenRequest, variant: string): AddTokenResult {
  const sheet = parseCss(text);
  const block = variantBlock(sheet, variant, false);
  const where = `:root${variant}`;
  const existing =
    block === undefined
      ? undefined
      : declarationsIn(sheet, block).find((declaration) => declaration.name === request.name);
  if (existing !== undefined) {
    return {
      text,
      changed: false,
      existing: { line: existing.line + 1, where },
      categoryCreated: false,
      mirrored: [],
      notes: [],
    };
  }
  const declaration = `  ${request.name}: ${request.value}; /* ${annotation(request.mode, request.value)} */`;
  const lines = sheet.lines;
  if (block !== undefined) {
    appendToBlock(lines, block, [declaration]);
  } else {
    const root = baseRoot(sheet);
    lines.splice(
      root === undefined || root.close === -1 ? lines.length : root.close + 1,
      0,
      '',
      `${where} {`,
      declaration,
      '}'
    );
  }
  return { text: lines.join('\n'), changed: true, categoryCreated: false, mirrored: [], notes: [] };
}

/** Writes the dark value into the nested `:root` of the dark `@media` block, creating what is missing. */
function addDarkValue(text: string, name: string, value: string): string {
  const sheet = parseCss(text);
  const media = sheet.blocks.find(
    (block) =>
      block.parent === undefined && /^@media\b.*prefers-color-scheme:\s*dark/.test(block.selector)
  );
  const lines = sheet.lines;
  if (media === undefined || media.close === -1) {
    while (lines.length > 0 && (lines.at(-1) ?? '').trim() === '') lines.pop();
    lines.push(
      '',
      '@media (prefers-color-scheme: dark) {',
      '  :root {',
      `    ${name}: ${value};`,
      '  }',
      '}',
      ''
    );
    return lines.join('\n');
  }
  const nested = sheet.blocks.find(
    (block) =>
      block.parent === media && block.selector.split(',').some((part) => part.trim() === ':root')
  );
  if (nested !== undefined && nested.close !== -1)
    appendToBlock(lines, nested, [`    ${name}: ${value};`]);
  else appendToBlock(lines, media, ['  :root {', `    ${name}: ${value};`, '  }']);
  return lines.join('\n');
}

/**
 * Mirrors an override into the `:root[data-theme="dark"]` and
 * `:root[data-theme="light"]` blocks the file already has, so every themed
 * list declares the same tokens. A block with a qualifier (`:not(...)`) is
 * written too, and reported.
 */
function mirrorThemes(
  text: string,
  request: AddTokenRequest
): { text: string; written: string[]; notes: string[] } {
  const written: string[] = [];
  const notes: string[] = [];
  let current = text;
  for (const [variant, value] of [
    ['[data-theme="dark"]', request.darkValue ?? request.value],
    ['[data-theme="light"]', request.value],
  ] as const) {
    const sheet = parseCss(current);
    const block = variantBlock(sheet, variant, true);
    if (block === undefined || block.close === -1) continue;
    if (declarationsIn(sheet, block).some((declaration) => declaration.name === request.name))
      continue;
    appendToBlock(sheet.lines, block, [`  ${request.name}: ${value};`]);
    current = sheet.lines.join('\n');
    written.push(block.selector);
    const qualifier = block.selector.slice(`:root${variant}`.length);
    if (canonical(qualifier) !== '') {
      notes.push(
        `Wrote ${request.name} into "${block.selector}"; its "${qualifier}" qualifier narrows where the override applies.`
      );
    }
  }
  return { text: current, written, notes };
}

function addBase(text: string, request: AddTokenRequest): AddTokenResult {
  const category = request.category ?? '';
  let sheet = parseCss(text);
  const root = baseRoot(sheet);
  if (root === undefined || root.close === -1) throw noTokenFile();

  const present = declarationsIn(sheet, root).find(
    (declaration) => declaration.name === request.name
  );
  if (present !== undefined) {
    const where = categoryAt(sheet, present.line);
    if (where === category) {
      return {
        text,
        changed: false,
        existing: { line: present.line + 1, where: `category "${category}"` },
        categoryCreated: false,
        mirrored: [],
        notes: [],
      };
    }
    throw new FireForgeError(
      'token-exists',
      `Token "${request.name}" is already declared outside category "${category}" (line ${present.line + 1}${where === undefined ? '' : `, category "${where}"`}). ` +
        'A token belongs to one category.',
      {
        hint:
          where === undefined
            ? 'Remove the stray declaration first.'
            : `Pass --category "${where}", or remove it first.`,
      }
    );
  }

  let categoryCreated = false;
  if (!categories(sheet).some((section) => section.name === category)) {
    if (request.createCategory !== true) throw unknownCategory(sheet, category);
    const lines = sheet.lines;
    lines.splice(isolateClose(lines, root), 0, '', `  /* = ${category} = */`);
    sheet = parseCss(lines.join('\n'));
    categoryCreated = true;
  }
  const section = categories(sheet).find((candidate) => candidate.name === category);
  if (section === undefined) throw unknownCategory(sheet, category);
  const lines = sheet.lines;
  let at = section.end;
  for (let i = section.end - 1; i > section.line; i--) {
    if ((lines[i] ?? '').trim() !== '') {
      at = i + 1;
      break;
    }
  }
  lines.splice(
    at,
    0,
    ...(request.description === undefined ? [] : [`  /* ${request.description} */`]),
    `  ${request.name}: ${request.value}; /* ${annotation(request.mode, request.value)} */`
  );
  let result = lines.join('\n');
  let mirrored: string[] = [];
  let notes: string[] = [];
  if (request.mode === 'override' && request.darkValue !== undefined) {
    result = addDarkValue(result, request.name, request.darkValue);
    const themed = mirrorThemes(result, request);
    ({ text: result, written: mirrored, notes } = themed);
  }
  return { text: result, changed: true, categoryCreated, mirrored, notes };
}

/**
 * Adds a token to the token file's text.
 *
 * @param text - The token file
 * @param request - The token
 * @throws `invalid-argument` for a request that cannot be written as CSS;
 *   `token-category-missing`, `token-exists` or `token-file-invalid` for a file that cannot take it
 */
export function addToken(text: string, request: AddTokenRequest): AddTokenResult {
  const variant = checkRequest(request);
  return variant === undefined ? addBase(text, request) : addVariant(text, request, variant);
}
