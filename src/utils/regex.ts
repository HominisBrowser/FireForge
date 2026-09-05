// SPDX-License-Identifier: EUPL-1.2
import { tokenizer as acornTokenizer, tokTypes as acornTokTypes } from 'acorn';

/**
 * Escapes special regex characters in a string.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches hex color values like #fff, #ff00ff, #ff00ff80 (longest-first alternation) */
const CSS_HEX_COLOR = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;

/** Matches rgb() or rgba() function calls */
const CSS_RGB_COLOR = /\brgba?\s*\(/;

/** Matches hsl() or hsla() function calls */
const CSS_HSL_COLOR = /\bhsla?\s*\(/;

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
 * Strips JS single-line and multi-line comments from source code, replacing
 * comment bytes with spaces (newlines inside block comments are kept) so
 * both character offsets and line numbers are preserved. String literals are
 * preserved intact.
 *
 * Uses acorn's tokenizer, which understands regex literals. A pure-regex
 * implementation does not model them, so two adjacent slashes inside a regex
 * (the tail of `/https?:\/\//`) read as a `//` line comment and the rest of
 * the line is blanked, corrupting whatever lint pass consumes the stripped
 * text. Firefox chrome sources contain preprocessor directives (`#ifdef`)
 * and other constructs acorn cannot tokenize. Those fall back to the legacy
 * regex strip, which handles strings but not regex literals.
 */
export function stripJsComments(source: string): string {
  const comments: Array<{ start: number; end: number }> = [];
  try {
    const t = acornTokenizer(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      onComment: (_isBlock, _text, start, end) => {
        comments.push({ start, end });
      },
    });
    // Drive the tokenizer to EOF. We only care about onComment callbacks.
    for (;;) {
      const token = t.getToken();
      if (token.type === acornTokTypes.eof) break;
    }
  } catch {
    return stripJsCommentsLegacy(source);
  }

  if (comments.length === 0) return source;
  const chars = source.split('');
  for (const { start, end } of comments) {
    for (let i = start; i < end; i++) {
      if (chars[i] !== '\n' && chars[i] !== '\r') {
        chars[i] = ' ';
      }
    }
  }
  return chars.join('');
}

/**
 * Legacy pure-regex comment strip, used only when acorn cannot tokenize
 * the source (preprocessor directives, syntax errors). Strings survive.
 * Regex literals are not modeled, so `//` inside a regex blanks the rest
 * of the line.
 */
function stripJsCommentsLegacy(source: string): string {
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
