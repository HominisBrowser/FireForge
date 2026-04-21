// SPDX-License-Identifier: EUPL-1.2
/**
 * Dark-mode insertion helpers for the tokens CSS scaffold.
 *
 * The 2026-04-21 eval reproduced a bug where `fireforge token add
 * --mode override --dark-value ...` landed the dark declaration
 * AFTER the nested `:root { }` inside the
 * `@media (prefers-color-scheme: dark)` block had already closed,
 * producing a declaration outside any rule block. The helpers here
 * scan the comment-stripped source lines to find the *inner* `:root`
 * block's closing `}` and return a line index the caller can splice
 * into. When the inner `:root` is missing (a scaffold that drifted
 * from the default), the fallback helper returns the outer `@media`
 * block's close so the caller can materialise a fresh `:root` wrapper
 * rather than dropping the dark value.
 */

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

  let darkMediaLine = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (/prefers-color-scheme:\s*dark/.test(stripped[i] ?? '')) {
      darkMediaLine = i;
      break;
    }
  }
  if (darkMediaLine === -1) return null;

  // Walk the comment-stripped lines after the @media header and find
  // the first `:root {` opener inside the block. The opening brace of
  // the selector may live on the same line as the selector name or on
  // the following line; either shape is tolerated.
  let rootOpenLine = -1;
  for (let i = darkMediaLine; i < stripped.length; i++) {
    const line = stripped[i] ?? '';
    if (/(^|[\s,{])\s*:root\b/.test(line)) {
      // Brace on the same line?
      if (/:root[^{}]*\{/.test(line)) {
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

  // Depth-count starting from the `:root` opener. The first `{`
  // encountered sets the entry depth to the initial counter value; the
  // closing brace that returns to that depth terminates the block.
  let depth = 0;
  let entryDepth = 0;
  let enteredBlock = false;
  for (let i = rootOpenLine; i < stripped.length; i++) {
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
  let darkMediaLine = -1;
  for (let i = 0; i < stripped.length; i++) {
    if (/prefers-color-scheme:\s*dark/.test(stripped[i] ?? '')) {
      darkMediaLine = i;
      break;
    }
  }
  if (darkMediaLine === -1) return -1;

  let depth = 0;
  let entryDepth = 0;
  let enteredBlock = false;
  for (let i = darkMediaLine; i < stripped.length; i++) {
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
