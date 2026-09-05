// SPDX-License-Identifier: EUPL-1.2
/* eslint-disable @typescript-eslint/no-non-null-assertion --
 * Test file: tests build their own input arrays and assert against elements
 * at known positions. Non-null assertions are the cleanest way to unpack
 * those positions. An `expect(x).toBeDefined()` dance before every assertion
 * would bloat the tests without catching anything real.
 */
import { describe, expect, it } from 'vitest';

import { buildHunks, computeLineDiff, diffLines, renderHunks } from '../diff-hunks.js';

describe('computeLineDiff', () => {
  it('returns an all-equal op stream when inputs are identical', () => {
    const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(ops.every((op) => op.type === 'equal')).toBe(true);
    expect(ops).toHaveLength(3);
  });

  it('records inserts and deletes around the common middle', () => {
    const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'x', 'c']);
    const types = ops.map((op) => op.type);
    expect(types).toContain('delete');
    expect(types).toContain('insert');
    expect(types).toContain('equal');
  });

  it('handles a pure prepend on the new side', () => {
    const ops = computeLineDiff(['b'], ['a', 'b']);
    expect(ops).toEqual([
      { type: 'insert', newIndex: 0, line: 'a' },
      { type: 'equal', oldIndex: 0, newIndex: 1, line: 'b' },
    ]);
  });

  it('handles a pure append on the new side', () => {
    const ops = computeLineDiff(['a'], ['a', 'b']);
    expect(ops).toEqual([
      { type: 'equal', oldIndex: 0, newIndex: 0, line: 'a' },
      { type: 'insert', newIndex: 1, line: 'b' },
    ]);
  });

  it('handles a pure deletion', () => {
    const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'c']);
    expect(ops).toEqual([
      { type: 'equal', oldIndex: 0, newIndex: 0, line: 'a' },
      { type: 'delete', oldIndex: 1, line: 'b' },
      { type: 'equal', oldIndex: 2, newIndex: 1, line: 'c' },
    ]);
  });

  it('handles empty old and empty new inputs', () => {
    expect(computeLineDiff([], [])).toEqual([]);
    expect(computeLineDiff([], ['a'])).toEqual([{ type: 'insert', newIndex: 0, line: 'a' }]);
    expect(computeLineDiff(['a'], [])).toEqual([{ type: 'delete', oldIndex: 0, line: 'a' }]);
  });
});

describe('buildHunks', () => {
  it('returns no hunks when there are no edits', () => {
    const ops = computeLineDiff(['a', 'b', 'c'], ['a', 'b', 'c']);
    expect(buildHunks(ops, 3)).toEqual([]);
  });

  it('emits a single hunk with surrounding context for one change', () => {
    const oldText = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'];
    const newText = ['l1', 'l2', 'l3', 'X', 'l5', 'l6', 'l7'];
    const ops = computeLineDiff(oldText, newText);
    const hunks = buildHunks(ops, 3);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
    // 3 context + 1 delete + 1 insert + 3 context = 8 lines in the hunk body
    expect(hunk.lines).toHaveLength(8);
    expect(hunk.lines.filter((line) => line.marker === '-')).toHaveLength(1);
    expect(hunk.lines.filter((line) => line.marker === '+')).toHaveLength(1);
  });

  it('emits multiple hunks when edits are separated by more than 2*context equal lines', () => {
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'];
    const newText = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'O'];
    const ops = computeLineDiff(oldText, newText);
    const hunks = buildHunks(ops, 3);
    expect(hunks.length).toBeGreaterThanOrEqual(2);
    // First hunk starts at line 1 (the 'a'->'A' change has no leading context).
    expect(hunks[0]!.oldStart).toBe(1);
    // Last hunk covers the trailing 'o'->'O' change, so its oldStart should
    // be well past the first hunk.
    expect(hunks[hunks.length - 1]!.oldStart).toBeGreaterThan(hunks[0]!.oldStart + 3);
  });

  it('merges adjacent edits when their context regions overlap', () => {
    // Two edits separated by only 2 equal lines and context=3 → one hunk.
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f'];
    const newText = ['A', 'b', 'c', 'd', 'e', 'F'];
    const ops = computeLineDiff(oldText, newText);
    const hunks = buildHunks(ops, 3);
    expect(hunks).toHaveLength(1);
    const hunk = hunks[0]!;
    expect(hunk.lines.filter((line) => line.marker === '-')).toHaveLength(2);
    expect(hunk.lines.filter((line) => line.marker === '+')).toHaveLength(2);
  });

  it('does not merge edits separated by more than 2*context equal lines', () => {
    // Two edits separated by 7 equal lines and context=3 → two hunks
    // (2*3=6, 7 > 6 → separate).
    const oldText = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const newText = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'I'];
    const ops = computeLineDiff(oldText, newText);
    const hunks = buildHunks(ops, 3);
    expect(hunks).toHaveLength(2);
  });
});

describe('diffLines + renderHunks', () => {
  it('renders a clean multi-hunk unified-diff view', () => {
    const oldText = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n';
    const newText = 'A\nb\nc\nd\ne\nf\ng\nh\ni\nj\nK\n';
    const hunks = diffLines(oldText, newText, 3);
    expect(hunks).toHaveLength(2);
    const rendered = renderHunks(hunks);
    const headers = rendered.filter((line) => line.kind === 'header');
    expect(headers).toHaveLength(2);
    expect(headers[0]!.text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/);

    // Removed and added markers should be present in the rendered stream.
    expect(rendered.some((line) => line.kind === 'removed' && line.text === '- a')).toBe(true);
    expect(rendered.some((line) => line.kind === 'added' && line.text === '+ A')).toBe(true);
    expect(rendered.some((line) => line.kind === 'removed' && line.text === '- k')).toBe(true);
    expect(rendered.some((line) => line.kind === 'added' && line.text === '+ K')).toBe(true);
  });

  it('returns no hunks when the inputs are identical (ignoring a trailing newline)', () => {
    expect(diffLines('a\nb\nc\n', 'a\nb\nc')).toEqual([]);
  });

  it('is deterministic across repeated calls', () => {
    const oldText = 'one\ntwo\nthree\nfour\nfive\n';
    const newText = 'one\ntwo\nTHREE\nfour\nfive\n';
    const first = renderHunks(diffLines(oldText, newText));
    const second = renderHunks(diffLines(oldText, newText));
    expect(first).toEqual(second);
  });
});
