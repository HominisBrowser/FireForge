// SPDX-License-Identifier: EUPL-1.2
/**
 * `token-scale`: values of governed CSS properties must resolve to a token
 * on the property's scale (`patchLint.tokenScales`).
 *
 * The raw-colour and token-prefix rules stop a patch from inventing colours
 * or referencing foreign custom properties, but say nothing about
 * `gap: 7px`, `font-size: 13px` or `z-index: 9999`. Those are the values a
 * design scale exists to remove, and without a rule they drift back one
 * literal at a time. A scale names its properties, the token prefix that
 * defines its steps, and the literals that are not steps at all (`0`,
 * `auto`, a percentage).
 *
 * Judged per value atom, after peeling `var()` innermost-first so a fallback
 * is held to the same scale as the token it backs: `var(--x-gap, 7px)` is a
 * literal in disguise. `calc()`, `min()`, `max()` and `clamp()` are
 * transparent, so a value built from tokens passes and one that adds a raw
 * length does not. Unitless multipliers inside them are literals too and
 * need an `allowLiterals` entry.
 *
 * Runs over CSS files the patch creates, not files it modifies: an upstream
 * stylesheet is not the fork's to put on a scale. A line carrying
 * `fireforge-ignore: token-scale` is skipped.
 */

import type { PatchLintIssue } from '../types/commands/index.js';
import type { PatchLintTokenScale } from '../types/config.js';
import { escapeRegex } from '../utils/regex.js';

const IGNORE_MARKER = 'fireforge-ignore: token-scale';

/** CSS-wide keywords: never a step on any scale, always legal. */
const CSS_WIDE_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer']);

const TOKEN_PLACEHOLDER = '\u0000token\u0000';

/** Exact name, or a `*`-suffixed prefix. */
function matchesName(name: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern
  );
}

function matchesLiteral(atom: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) =>
    new RegExp(`^${pattern.split('*').map(escapeRegex).join('.*')}$`).test(atom)
  );
}

/**
 * Returns the first atom of `value` that is off `scale`, or undefined when
 * every atom resolves to the scale.
 */
export function findOffScaleAtom(value: string, scale: PatchLintTokenScale): string | undefined {
  let rest = value.replace(/!\s*important\s*$/i, '');
  const varPattern = /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/;
  for (let match = varPattern.exec(rest); match !== null; match = varPattern.exec(rest)) {
    const name = match[1] ?? '';
    if (!name.startsWith(scale.prefix) && !matchesName(name, scale.allow ?? [])) {
      return `var(${name})`;
    }
    const fallback = match[2];
    if (fallback !== undefined && fallback.trim() !== '') {
      const offending = findOffScaleAtom(fallback, scale);
      if (offending !== undefined) return offending;
    }
    rest = `${rest.slice(0, match.index)} ${TOKEN_PLACEHOLDER} ${rest.slice(match.index + match[0].length)}`;
  }
  const atoms = rest
    .replace(/\b(?:calc|min|max|clamp)\(/gi, ' ')
    .replace(/[(),]/g, ' ')
    .split(/\s+/)
    .filter((atom) => atom !== '' && !['+', '-', '*', '/'].includes(atom));
  return atoms.find(
    (atom) =>
      atom !== TOKEN_PLACEHOLDER &&
      !CSS_WIDE_KEYWORDS.has(atom.toLowerCase()) &&
      !matchesLiteral(atom, scale.allowLiterals ?? [])
  );
}

/** Blanks block comments, keeping newlines so offsets map to lines. */
function maskComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Lints one patch-created CSS file against the configured scales.
 *
 * @param file - Engine-relative path, for the issue
 * @param css - The file's full content
 * @param scales - `patchLint.tokenScales`
 * @returns One `token-scale` error per off-scale declaration
 */
export function lintTokenScales(
  file: string,
  css: string,
  scales: readonly PatchLintTokenScale[]
): PatchLintIssue[] {
  if (scales.length === 0) return [];
  const rawLines = css.split('\n');
  const masked = maskComments(css);
  const issues: PatchLintIssue[] = [];
  const declaration = /(^|[{;\s])([a-zA-Z][a-zA-Z-]*)\s*:\s*([^;{}]*)/g;
  for (let match = declaration.exec(masked); match !== null; match = declaration.exec(masked)) {
    const property = (match[2] ?? '').toLowerCase();
    const value = (match[3] ?? '').trim();
    const scale = scales.find((candidate) => matchesName(property, candidate.properties));
    if (scale === undefined || value === '') continue;
    const start = match.index + (match[1] ?? '').length;
    const line = masked.slice(0, start).split('\n').length;
    if ((rawLines[line - 1] ?? '').includes(IGNORE_MARKER)) continue;
    const atom = findOffScaleAtom(value, scale);
    if (atom === undefined) continue;
    issues.push({
      file,
      check: 'token-scale',
      fingerprint: `token-scale:${file}:${property}:${value}`,
      message:
        `Line ${String(line)}: ${property}: ${value} is off the ${scale.prefix}* scale ` +
        `("${atom}"). Use a ${scale.prefix}* token, or list a reviewed exception in ` +
        `patchLint.tokenScales (allowLiterals / allow) or mark the line "${IGNORE_MARKER}".`,
      severity: 'error',
    });
  }
  return issues;
}
