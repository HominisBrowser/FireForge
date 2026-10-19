// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge token lint`: structural checks over the design-token system.
 *
 * - `token-lockstep`: a themed override block (the dark `@media` mirror, a
 *   `:root[variant]` block) declares only tokens the base `:root` declares.
 *   An override with no base is a token that exists only in one theme, so
 *   every other theme resolves it to nothing.
 * - `token-undeclared`: a `var(--<prefix>…)` reference in the tokens CSS or
 *   in a CSS file the patch queue touches names a token no block of the
 *   tokens CSS declares. Same-file declarations, declarations of a sheet
 *   that loads beside it (see `token-sibling-sheets.ts`), `furnace.json`
 *   `tokenAllowlist` and `runtimeVariables` are exempt, matching the
 *   `token-prefix-violation` rule's notion of a runtime channel. A
 *   reference with a fallback (`var(--x, 0)`) is optional by construction
 *   (a host hook, a channel set from JS) and is not reported.
 *
 * Built on `token-category.ts`'s base-block and comment-mask primitives, so
 * this report and `token add` agree on which block is the base.
 */

import { findBaseRootBounds, maskCommentLines } from './token-category.js';

/** One `token lint` finding. */
export interface TokenLintFinding {
  check: 'token-lockstep' | 'token-undeclared';
  /** Engine-relative file. */
  file: string;
  /** 1-based line. */
  line: number;
  /** The custom property at fault. */
  token: string;
  message: string;
}

/** A custom-property declaration with the selector trail of its block. */
interface TokenDeclaration {
  name: string;
  line: number;
  block: string;
}

const DECLARATION = /(?:^|[{;\s])(--[A-Za-z0-9_-]+)\s*:/g;

function selectorBefore(text: string): string {
  const selector = text.slice(Math.max(text.lastIndexOf('}'), text.lastIndexOf(';')) + 1).trim();
  return selector.length > 0 ? selector.replace(/\s+/g, ' ') : '(block)';
}

/**
 * Every custom-property declaration in a CSS file with the selector trail
 * of the block holding it, outermost first, joined with ` > `.
 */
function collectDeclarations(lines: string[]): TokenDeclaration[] {
  const masked = maskCommentLines(lines);
  const trail: string[] = [];
  const found: TokenDeclaration[] = [];
  let pending = '';
  for (const [index, line] of masked.entries()) {
    for (const match of line.matchAll(DECLARATION)) {
      found.push({
        name: match[1] ?? '',
        line: index + 1,
        block: trail.length > 0 ? trail.join(' > ') : '(file scope)',
      });
    }
    for (const char of line) {
      if (char === '{') {
        trail.push(selectorBefore(pending));
        pending = '';
      } else if (char === '}') {
        trail.pop();
        pending = '';
      } else {
        pending += char;
      }
    }
    pending += '\n';
  }
  return found;
}

/** Every custom property the tokens CSS declares, in any block. */
export function collectDeclaredTokenNames(lines: string[]): Set<string> {
  return new Set(collectDeclarations(lines).map((declaration) => declaration.name));
}

/**
 * Themed override declarations of `tokenPrefix` tokens that the base
 * `:root` block does not declare.
 *
 * @param lines - Tokens CSS split into lines
 * @param tokensCssPath - Engine-relative path, for the findings
 * @param tokenPrefix - Only tokens with this prefix are held to lockstep;
 *   a themed block may still override platform properties
 */
export function lintTokenLockstep(
  lines: string[],
  tokensCssPath: string,
  tokenPrefix: string
): TokenLintFinding[] {
  const bounds = findBaseRootBounds(lines);
  if (bounds === undefined) return [];
  const close = bounds.close === -1 ? lines.length : bounds.close;
  const declarations = collectDeclarations(lines);
  const inBase = (line: number): boolean => line - 1 >= bounds.open && line - 1 <= close;
  const base = new Set(declarations.filter((d) => inBase(d.line)).map((d) => d.name));
  return declarations
    .filter((d) => !inBase(d.line) && d.name.startsWith(tokenPrefix) && !base.has(d.name))
    .map((d) => ({
      check: 'token-lockstep' as const,
      file: tokensCssPath,
      line: d.line,
      token: d.name,
      message:
        `${d.name} is declared in ${d.block} but not in the base :root block, so every other ` +
        'theme resolves it to nothing. Declare the base value first (fireforge token add), ' +
        'or drop the override.',
    }));
}

/**
 * `var(--<prefix>…)` references naming a token the tokens CSS never
 * declares.
 *
 * @param file - Engine-relative path, for the findings
 * @param css - The file's content
 * @param tokenPrefix - Only references with this prefix are checked
 * @param declared - {@link collectDeclaredTokenNames} of the tokens CSS
 * @param exempt - `tokenAllowlist` and `runtimeVariables` names
 */
export function lintUndeclaredTokenReferences(
  file: string,
  css: string,
  tokenPrefix: string,
  declared: ReadonlySet<string>,
  exempt: ReadonlySet<string>
): TokenLintFinding[] {
  const lines = css.split('\n');
  const local = collectDeclaredTokenNames(lines);
  const findings: TokenLintFinding[] = [];
  const seen = new Set<string>();
  for (const [index, line] of maskCommentLines(lines).entries()) {
    for (const match of line.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)\s*(,)?/g)) {
      const name = match[1] ?? '';
      if (match[2] !== undefined) continue;
      if (!name.startsWith(tokenPrefix) || declared.has(name) || local.has(name)) continue;
      if (exempt.has(name) || seen.has(name)) continue;
      seen.add(name);
      findings.push({
        check: 'token-undeclared',
        file,
        line: index + 1,
        token: name,
        message:
          `var(${name}) names a token the tokens CSS does not declare, so it resolves to ` +
          'nothing. Add the token, fix the name, or list a runtime channel in furnace.json ' +
          'runtimeVariables.',
      });
    }
  }
  return findings;
}
