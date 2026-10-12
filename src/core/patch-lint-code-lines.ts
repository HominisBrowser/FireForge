// SPDX-License-Identifier: EUPL-1.2
/**
 * Line counting for the size rules: raw lines, code lines, and the per-line
 * code mask the `addedCode` patch-size metric reads off a file's
 * post-image.
 *
 * "Code" means a line left non-blank once comments are blanked. JS goes
 * through acorn's tokenizer (`stripJsCommentsParsed`), so a regex literal
 * containing `/*`, a string containing `//`, nested template literals,
 * JSDoc and a shebang are all judged correctly, and a blank line inside a
 * template literal counts as blank.
 */

import { stripJsCommentsParsed } from '../utils/regex.js';
import { expandedFragmentLineMask } from './furnace-css-fragments.js';
import { maskCssComments } from './patch-lint-css.js';

/**
 * Splits content into lines the way `wc -l` reports them: a trailing
 * newline terminates the last line rather than starting an empty extra one.
 */
function splitContentLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Counts the lines of `content` the way `wc -l` reports them. A naive
 * `split('\n').length` over-counts by one for any content ending in `\n`
 * (the common case), making the size rules fire one line early against
 * the operator's own `wc -l` measurement.
 */
export function countRawLines(content: string): number {
  return splitContentLines(content).length;
}

/** The result of {@link countCodeLines}. */
export interface CodeLineCount {
  /**
   * Lines that carry code: non-blank once comments are blanked. When the
   * source could not be tokenized this is the raw line count instead, the
   * upper bound, so an unparsable file never measures smaller than it is.
   */
  lines: number;
  /** False when acorn could tokenize the source neither as a module nor as a script. */
  parsed: boolean;
}

const isBlank = (line: string): boolean => line.trim() === '';

/**
 * Counts the code lines of a JS source: comments are blanked by acorn's
 * tokenizer (module goal first, then script, since chrome subscripts are
 * scripts) and the non-blank lines are counted. When neither goal
 * tokenizes, the raw line count is returned with `parsed: false`. A regex
 * fallback would under-count, which fails open.
 *
 * @param content - JS source text
 */
export function countCodeLines(content: string): CodeLineCount {
  const stripped = stripJsCommentsParsed(content);
  if (stripped === null) return { lines: countRawLines(content), parsed: false };
  return {
    lines: splitContentLines(stripped).filter((line) => !isBlank(line)).length,
    parsed: true,
  };
}

const JS_FILE = /\.(?:m?js|jsm|cjs)$/;
const MARKUP_FILE = /\.(?:x?html|xml|svg|xul|dtd)$/;
const HASH_COMMENT_FILE =
  /(?:\.(?:ftl|properties|toml|ini|mn|build|py|conf|configure|sh|ya?ml|in|cfg|mozbuild)|(?:^|\/)(?:Makefile|mozconfig))$/;

/** Line-comment leaders per hash-comment file kind. */
function lineCommentPattern(file: string): RegExp {
  if (/\.(?:ini|in)$/.test(file)) return /^\s*[#;]/;
  if (file.endsWith('.properties')) return /^\s*[#!]/;
  return /^\s*#/;
}

/** Masks `<!-- … -->` comments, keeping newlines. Unclosed comments run to EOF. */
function maskMarkupComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, (m) => m.replace(/[^\n]/g, ' '));
}

/** The per-line code mask of one post-image. */
export interface CodeLineMask {
  /** `code[i]` is true when line `i + 1` carries code. */
  code: boolean[];
  /** False for a JS file acorn could not tokenize; every non-blank line then counts. */
  parsed: boolean;
}

/**
 * Classifies every line of a file's post-image as code or not, by file
 * kind: JS through acorn, CSS block comments, `<!-- -->` in markup, and
 * whole-line `#` comments (`;` for `.ini`/`.in`, `!` for `.properties`) in
 * Fluent, manifests, `moz.build` and similar. Any other file counts every
 * non-blank line. In CSS, lines inside a Furnace fragment expansion
 * (`@fireforge-include` … `@fireforge-end-include`) are not code of this
 * file: they are a copy of a shared fragment.
 *
 * @param file - Engine-relative path, used only to pick the file kind
 * @param content - The post-image text
 */
export function codeLineMask(file: string, content: string): CodeLineMask {
  if (JS_FILE.test(file)) {
    const stripped = stripJsCommentsParsed(content);
    const source = stripped ?? content;
    return { code: source.split('\n').map((line) => !isBlank(line)), parsed: stripped !== null };
  }
  if (file.endsWith('.css')) {
    const inFragment = expandedFragmentLineMask(content);
    const code = maskCssComments(content)
      .split('\n')
      .map((line, i) => !isBlank(line) && inFragment[i] !== true);
    return { code, parsed: true };
  }
  if (MARKUP_FILE.test(file)) {
    return {
      code: maskMarkupComments(content)
        .split('\n')
        .map((l) => !isBlank(l)),
      parsed: true,
    };
  }
  const comment = HASH_COMMENT_FILE.test(file) ? lineCommentPattern(file) : undefined;
  const code = content.split('\n').map((line) => !isBlank(line) && !comment?.test(line));
  return { code, parsed: true };
}
