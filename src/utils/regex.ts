// SPDX-License-Identifier: EUPL-1.2
/**
 * Escapes special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches hex color values like #fff, #ff00ff, #ff00ff80 (longest-first alternation) */
export const CSS_HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;

/** Matches rgb() or rgba() function calls */
export const CSS_RGB_COLOR = /\brgba?\s*\(/;

/** Matches hsl() or hsla() function calls */
export const CSS_HSL_COLOR = /\bhsla?\s*\(/;

// Global variants for counting (cached to avoid re-creation per call)
const CSS_HEX_COLOR_G = new RegExp(CSS_HEX_COLOR.source, 'g');
const CSS_RGB_COLOR_G = new RegExp(CSS_RGB_COLOR.source, 'g');
const CSS_HSL_COLOR_G = new RegExp(CSS_HSL_COLOR.source, 'g');

/**
 * Returns true if the content contains any raw CSS color values (hex, rgb, hsl).
 */
export function hasRawCssColors(content: string): boolean {
  return CSS_HEX_COLOR.test(content) || CSS_RGB_COLOR.test(content) || CSS_HSL_COLOR.test(content);
}

/**
 * Strips JS single-line and multi-line comments from source code, replacing them
 * with spaces of equal length to preserve character offsets. String literals
 * (single-quoted, double-quoted, and template) are preserved intact.
 */
export function stripJsComments(source: string): string {
  return source.replace(
    /\/\/.*$|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gm,
    (match) => (match.startsWith('/') ? ' '.repeat(match.length) : match)
  );
}

/**
 * Counts the total number of raw CSS color values (hex, rgb, hsl) in content.
 */
export function countRawCssColors(content: string): number {
  return (
    (content.match(CSS_HEX_COLOR_G)?.length ?? 0) +
    (content.match(CSS_RGB_COLOR_G)?.length ?? 0) +
    (content.match(CSS_HSL_COLOR_G)?.length ?? 0)
  );
}
