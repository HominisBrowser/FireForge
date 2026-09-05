// SPDX-License-Identifier: EUPL-1.2
/**
 * Dark-mode insertion helpers for the tokens CSS scaffold.
 *
 * `fireforge token add --mode override --dark-value ...` must land the dark
 * declaration INSIDE the nested `:root { }` of the
 * `@media (prefers-color-scheme: dark)` block; landing after that block has
 * closed produces a declaration outside any rule. The helpers here scan the
 * comment-stripped source lines to find the *inner* `:root` block's closing
 * `}` and return a line index the caller can splice into. When the inner
 * `:root` is missing (a scaffold that drifted from the default), the
 * fallback helper returns the outer `@media` block's close so the caller can
 * materialise a fresh `:root` wrapper rather than dropping the dark value.
 */

/**
 * True when `line` carries a `:root` selector whose opening brace is on the
 * same line, with no intervening brace of either kind.
 *
 * Index arithmetic rather than `/:root[^{}]*\{/`: that pattern restarts at
 * every `:root` in the line, which is quadratic on a line repeating the
 * selector (CodeQL `js/polynomial-redos`). `tokens.css` comes from a
 * consumer's engine tree, so such a line needs no attacker to arrive.
 */
function rootOpensBraceOnLine(line: string): boolean {
  const brace = line.indexOf('{');
  if (brace === -1) return false;
  const root = line.lastIndexOf(':root', brace - ':root'.length);
  if (root === -1 || root + ':root'.length > brace) return false;
  return !line.slice(root + ':root'.length, brace).includes('}');
}

/**
 * Strips the content of `/* ... *\/` block comments from an array of
 * CSS source lines while preserving each line's length. Indexed scans
 * over the returned mirror line up with the original, so callers that
 * compute an insertion index against the stripped array can splice
 * into the original array at the same index.
 *
 * We blank the comment body with spaces (rather than removing it) so
 * any downstream consumer that indexes by column — or derives an
 * insertion index as a line number in the original array — still
 * agrees on line numbers.
 */
export function stripBlockCommentsInLines(lines: string[]): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  for (const original of lines) {
    let line = '';
    for (let i = 0; i < original.length; i++) {
      if (inBlockComment) {
        if (original[i] === '*' && original[i + 1] === '/') {
          line += '  ';
          i += 1;
          inBlockComment = false;
        } else {
          line += ' ';
        }
      } else if (original[i] === '/' && original[i + 1] === '*') {
        line += '  ';
        i += 1;
        inBlockComment = true;
      } else {
        // `original[i]` is provably defined here (the bounds check is
        // the loop condition), but TS narrows it to `string | undefined`.
        // Default to empty string so the concat stays well-typed.
        line += original[i] ?? '';
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Finds the closing `}` line of the nested `:root { ... }` block inside
 * a `@media (prefers-color-scheme: dark)` block. Returns `-1` when the
 * media block exists but the nested `:root` block is missing; returns
 * `null` when the `@media` block itself is absent.
 *
 * Runs the scan over a comment-stripped mirror of the source lines so
 * braces inside CSS comments (`/* before { after *\/`) do not offset
 * the depth counter. The scan is deliberately line-indexed so callers
 * can splice into the original `lines` array at the returned index.
 */
export function findDarkRootInsertionIndex(lines: string[]): number | null {
  const stripped = stripBlockCommentsInLines(lines);

  const darkMediaLine = stripped.findIndex((line) => /prefers-color-scheme:\s*dark/.test(line));
  if (darkMediaLine === -1) return null;

  // Walk the comment-stripped lines after the @media header and find
  // the first `:root {` opener inside the block. The opening brace of
  // the selector may live on the same line as the selector name or on
  // the following line; either shape is tolerated.
  let rootOpenLine = -1;
  for (let i = darkMediaLine; i < stripped.length; i++) {
    const line = stripped[i] ?? '';
    if (/(?:^|[\s,{]):root\b/.test(line)) {
      // Brace on the same line?
      if (rootOpensBraceOnLine(line)) {
        rootOpenLine = i;
        break;
      }
      // Otherwise scan forward for the opening brace, stopping at the
      // first `}` or second selector that would mean the `:root`
      // declaration never opened a block.
      for (let j = i + 1; j < stripped.length; j++) {
        const next = stripped[j] ?? '';
        if (/\{/.test(next)) {
          rootOpenLine = j;
          break;
        }
        if (/[};]/.test(next)) break;
      }
      if (rootOpenLine !== -1) break;
    }
  }
  if (rootOpenLine === -1) return -1;

  // Depth-count starting from the `:root` opener; see findBlockCloseIndex.
  return findBlockCloseIndex(stripped, rootOpenLine);
}

/**
 * Depth-counts braces from `startLine` (whose lines must already have
 * block comments stripped), returning the index of the line on which the
 * block opened there returns to its entry depth — i.e. the line carrying
 * the block's closing `}` — or -1 when the block never closes. The first
 * `{` encountered sets the entry depth, so the scan may start on the
 * selector/at-rule line itself rather than on the opener.
 */
export function findBlockCloseIndex(stripped: string[], startLine: number): number {
  let depth = 0;
  let entryDepth = 0;
  let enteredBlock = false;
  for (let i = startLine; i < stripped.length; i++) {
    const line = stripped[i] ?? '';
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (!enteredBlock) {
          entryDepth = depth - 1;
          enteredBlock = true;
        }
      } else if (ch === '}') {
        depth--;
      }
    }
    if (enteredBlock && depth === entryDepth) {
      return i;
    }
  }
  return -1;
}

/**
 * Finds the closing `}` of the outermost
 * `@media (prefers-color-scheme: dark)` block. Used as the fallback
 * landing site when the scaffold has no nested `:root { }` — the
 * insertion helper uses this index to splice a brand-new `:root`
 * wrapper containing the dark declaration, rather than dropping the
 * value.
 */
export function findDarkMediaCloseIndex(lines: string[]): number {
  const stripped = stripBlockCommentsInLines(lines);
  const darkMediaLine = stripped.findIndex((line) => /prefers-color-scheme:\s*dark/.test(line));
  if (darkMediaLine === -1) return -1;

  return findBlockCloseIndex(stripped, darkMediaLine);
}
