// SPDX-License-Identifier: EUPL-1.2
import { assert, expectDefined } from '../utils/assert.js';

/**
 * An edit op produced by {@link computeLineDiff}. Indices are 0-based into the
 * source line arrays; `line` holds the verbatim text so callers do not have to
 * keep the input arrays around while rendering.
 */
export interface LineDiffOp {
  type: 'equal' | 'delete' | 'insert';
  oldIndex?: number;
  newIndex?: number;
  line: string;
}

/**
 * A single line inside a hunk, rendered as one of the three unified-diff
 * markers. Content is the raw line text with no marker prefix so callers can
 * apply their own coloring before the prefix is added.
 */
export interface HunkLine {
  marker: ' ' | '-' | '+';
  content: string;
}

/**
 * A unified-diff hunk. Line numbers are 1-based to match `@@ -X,N +Y,M @@`
 * convention.
 */
export interface DiffHunk {
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
  lines: HunkLine[];
}

/**
 * A pre-split line output ready for the caller to apply color and emit. Kept
 * free of color codes so the same structure can be unit-tested without
 * depending on the logger.
 */
export interface RenderedDiffLine {
  kind: 'header' | 'context' | 'removed' | 'added';
  text: string;
}

/**
 * Maximum combined LCS table side-length before bailing out of the exact
 * O(m·n) diff and falling back to the simpler single-region coalesce. Chosen
 * so the worst-case Int32Array allocation stays under ~16 MB. Typical
 * Firefox widget files are a few hundred lines, so the fast path handles the
 * everyday case; the fallback keeps the command usable on a very large file.
 */
const LCS_LINE_LIMIT = 2000;

/** Splits a string on `\n`, discarding a single trailing empty line from a terminal newline. */
function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * LCS-based line diff. Runs in O(m·n) time and memory using a single flat
 * `Int32Array` for the DP table. Guarded by {@link LCS_LINE_LIMIT} so callers
 * on very large files transparently get the coalesced fallback instead of
 * allocating hundreds of megabytes.
 *
 * Behavior note: the backtrack walks diagonals in a deterministic order, so
 * the same input always produces the same op sequence. This matters for
 * snapshot tests and for UI stability when the user re-runs `furnace diff`.
 */
export function computeLineDiff(
  oldLines: readonly string[],
  newLines: readonly string[]
): LineDiffOp[] {
  const m = oldLines.length;
  const n = newLines.length;

  // The DP below indexes `dp`, `oldLines`, and `newLines` about 4·m·n times
  // for a worst-case pair, so its bounds are established once here rather
  // than re-checked per access. Callers gate on LCS_LINE_LIMIT before
  // reaching this function; if that gate is ever moved or removed, this is
  // where the resulting allocation blow-up surfaces as a named failure
  // instead of an out-of-memory crash.
  assert(
    m <= LCS_LINE_LIMIT && n <= LCS_LINE_LIMIT,
    () => `line diff inputs are within LCS_LINE_LIMIT (got ${m}x${n}, limit ${LCS_LINE_LIMIT})`
  );

  const dp = new Int32Array((m + 1) * (n + 1));
  const stride = n + 1;

  // Every index into `dp` is `row * stride + column` with row ≤ m and
  // column ≤ n, which is exactly the extent allocated above.
  assert(dp.length === (m + 1) * stride, 'DP table is sized to its stride');

  /* eslint-disable @typescript-eslint/no-non-null-assertion --
   * The DP fill and backtrack below are the one hot path in this module:
   * O(m·n) iterations, up to ~4M for a LCS_LINE_LIMIT-sized pair. Every
   * index is structurally bounded by the loop conditions (`i <= m`,
   * `j <= n`, `i > 0`, `j > 0`) against the extents asserted immediately
   * above, so the non-null assertions encode a property already checked
   * once per call rather than one that is never checked at all. The
   * rendering loops further down, which run O(ops), use `expectDefined`
   * instead — this exemption is for the quadratic block only.
   */
  for (let i = 1; i <= m; i++) {
    const oldLine = oldLines[i - 1]!;
    const rowOffset = i * stride;
    const prevRowOffset = (i - 1) * stride;
    for (let j = 1; j <= n; j++) {
      if (oldLine === newLines[j - 1]) {
        dp[rowOffset + j] = dp[prevRowOffset + j - 1]! + 1;
      } else {
        const up = dp[prevRowOffset + j]!;
        const left = dp[rowOffset + j - 1]!;
        dp[rowOffset + j] = up >= left ? up : left;
      }
    }
  }

  const ops: LineDiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ type: 'equal', oldIndex: i - 1, newIndex: j - 1, line: oldLines[i - 1]! });
      i--;
      j--;
      continue;
    }
    const up = dp[(i - 1) * stride + j]!;
    const left = dp[i * stride + j - 1]!;
    if (up >= left) {
      ops.push({ type: 'delete', oldIndex: i - 1, line: oldLines[i - 1]! });
      i--;
    } else {
      ops.push({ type: 'insert', newIndex: j - 1, line: newLines[j - 1]! });
      j--;
    }
  }
  while (i > 0) {
    ops.push({ type: 'delete', oldIndex: i - 1, line: oldLines[i - 1]! });
    i--;
  }
  while (j > 0) {
    ops.push({ type: 'insert', newIndex: j - 1, line: newLines[j - 1]! });
    j--;
  }
  /* eslint-enable @typescript-eslint/no-non-null-assertion */
  ops.reverse();
  return ops;
}

/**
 * Groups an op stream into unified-diff hunks with `context` lines of
 * surrounding equal-line context. Adjacent edit runs whose expanded context
 * regions overlap are merged into a single hunk, matching `diff -U N`.
 *
 * Returns an empty array when the two inputs were identical.
 */
export function buildHunks(ops: readonly LineDiffOp[], context: number): DiffHunk[] {
  const editRanges: { start: number; end: number }[] = [];
  let i = 0;
  while (i < ops.length) {
    if (expectDefined(ops[i], () => `diff op at index ${i}`).type !== 'equal') {
      const start = i;
      while (
        i < ops.length &&
        expectDefined(ops[i], () => `diff op at index ${i}`).type !== 'equal'
      )
        i++;
      editRanges.push({ start, end: i });
    } else {
      i++;
    }
  }
  if (editRanges.length === 0) return [];

  const expanded: { start: number; end: number }[] = [];
  for (const range of editRanges) {
    const start = Math.max(0, range.start - context);
    const end = Math.min(ops.length, range.end + context);
    const prev = expanded[expanded.length - 1];
    if (prev && start <= prev.end) {
      prev.end = Math.max(prev.end, end);
    } else {
      expanded.push({ start, end });
    }
  }

  const hunks: DiffHunk[] = [];
  for (const range of expanded) {
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < range.start; k++) {
      const op = expectDefined(ops[k], () => `diff op at index ${k}`);
      if (op.type === 'equal') {
        oldLine++;
        newLine++;
      } else if (op.type === 'delete') {
        oldLine++;
      } else {
        newLine++;
      }
    }

    const hunkLines: HunkLine[] = [];
    let oldLength = 0;
    let newLength = 0;
    for (let k = range.start; k < range.end; k++) {
      const op = expectDefined(ops[k], () => `diff op at index ${k}`);
      if (op.type === 'equal') {
        hunkLines.push({ marker: ' ', content: op.line });
        oldLength++;
        newLength++;
      } else if (op.type === 'delete') {
        hunkLines.push({ marker: '-', content: op.line });
        oldLength++;
      } else {
        hunkLines.push({ marker: '+', content: op.line });
        newLength++;
      }
    }

    hunks.push({
      oldStart: oldLength === 0 ? oldLine - 1 : oldLine,
      oldLength,
      newStart: newLength === 0 ? newLine - 1 : newLine,
      newLength,
      lines: hunkLines,
    });
  }
  return hunks;
}

/**
 * Fallback for inputs that exceed {@link LCS_LINE_LIMIT}. Reproduces the
 * original single-region coalesce: match the common prefix and suffix, then
 * emit one hunk containing the middle region plus `context` lines on each
 * side. Intentionally dumb — the fast path handles normal files, and this
 * only keeps the command usable on pathologically large inputs without
 * allocating a huge DP table.
 */
function coalescedHunk(
  oldLines: readonly string[],
  newLines: readonly string[],
  context: number
): DiffHunk[] {
  let firstDiff = 0;
  while (firstDiff < oldLines.length && firstDiff < newLines.length) {
    if (oldLines[firstDiff] !== newLines[firstDiff]) break;
    firstDiff++;
  }

  let lastOldDiff = oldLines.length - 1;
  let lastNewDiff = newLines.length - 1;
  while (lastOldDiff >= firstDiff && lastNewDiff >= firstDiff) {
    if (oldLines[lastOldDiff] !== newLines[lastNewDiff]) break;
    lastOldDiff--;
    lastNewDiff--;
  }

  if (lastOldDiff < firstDiff && lastNewDiff < firstDiff) {
    return [];
  }

  const contextStart = Math.max(0, firstDiff - context);
  const contextEndNew = Math.min(newLines.length - 1, lastNewDiff + context);

  const hunkLines: HunkLine[] = [];
  for (let k = contextStart; k < firstDiff; k++) {
    hunkLines.push({ marker: ' ', content: expectDefined(oldLines[k], () => `old line ${k}`) });
  }
  for (let k = firstDiff; k <= lastOldDiff; k++) {
    hunkLines.push({ marker: '-', content: expectDefined(oldLines[k], () => `old line ${k}`) });
  }
  for (let k = firstDiff; k <= lastNewDiff; k++) {
    hunkLines.push({ marker: '+', content: expectDefined(newLines[k], () => `new line ${k}`) });
  }
  // Trailing context comes from the common suffix, which lives at DIFFERENT
  // indices on each side (lastOldDiff+1… vs lastNewDiff+1…). Mixing the two
  // coordinate spaces emits wrong context on asymmetric edits and drops the
  // trailing lines from the @@ header lengths, so the rendered header
  // disagrees with the body.
  for (let k = lastNewDiff + 1; k <= contextEndNew; k++) {
    hunkLines.push({ marker: ' ', content: expectDefined(newLines[k], () => `new line ${k}`) });
  }

  const leadingContext = firstDiff - contextStart;
  // Common-suffix symmetry: oldLen-1-lastOldDiff === newLen-1-lastNewDiff,
  // so both sides clamp to the same trailing context count.
  const trailingContext = contextEndNew - lastNewDiff;
  const oldLength = lastOldDiff - firstDiff + 1 + leadingContext + trailingContext;
  const newLength = lastNewDiff - firstDiff + 1 + leadingContext + trailingContext;

  return [
    {
      oldStart: contextStart + 1,
      oldLength,
      newStart: contextStart + 1,
      newLength,
      lines: hunkLines,
    },
  ];
}

/**
 * Computes a multi-hunk line diff between two strings. This is the public
 * entry point that {@link furnaceDiffCommand} uses. On normal inputs this
 * runs the exact LCS path and returns a proper multi-hunk diff; on inputs
 * that exceed {@link LCS_LINE_LIMIT} it falls back to a single coalesced
 * hunk so the command stays useful instead of OOMing.
 */
export function diffLines(oldText: string, newText: string, context: number = 3): DiffHunk[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length > LCS_LINE_LIMIT || newLines.length > LCS_LINE_LIMIT) {
    return coalescedHunk(oldLines, newLines, context);
  }
  const ops = computeLineDiff(oldLines, newLines);
  return buildHunks(ops, context);
}

/**
 * Renders hunks into a flat list of lines the caller can emit one by one.
 * Kept color-free so unit tests can assert exact output and so the caller
 * can apply its own formatting (e.g. `formatErrorText` / `formatSuccessText`).
 */
export function renderHunks(hunks: readonly DiffHunk[]): RenderedDiffLine[] {
  const out: RenderedDiffLine[] = [];
  for (const hunk of hunks) {
    out.push({
      kind: 'header',
      text: `@@ -${hunk.oldStart},${hunk.oldLength} +${hunk.newStart},${hunk.newLength} @@`,
    });
    for (const line of hunk.lines) {
      if (line.marker === ' ') {
        out.push({ kind: 'context', text: `  ${line.content}` });
      } else if (line.marker === '-') {
        out.push({ kind: 'removed', text: `- ${line.content}` });
      } else {
        out.push({ kind: 'added', text: `+ ${line.content}` });
      }
    }
  }
  return out;
}
