// SPDX-License-Identifier: EUPL-1.2
import { describe, expect, it } from 'vitest';

import {
  findNextTable,
  findTableAfterHeading,
  findTableByColumns,
  insertRow,
  rewriteTableRows,
  serializeRow,
  updateCellByKey,
} from '../markdown-table.js';

describe('markdown-table', () => {
  describe('findNextTable', () => {
    it('parses a basic pipe table', () => {
      const lines = [
        '| Name | Value |',
        '|------|-------|',
        '| foo  | 1     |',
        '| bar  | 2     |',
      ];
      const table = findNextTable(lines, 0);
      expect(table).not.toBeNull();
      expect(table?.headers).toEqual(['Name', 'Value']);
      expect(table?.rows).toEqual([
        ['foo', '1'],
        ['bar', '2'],
      ]);
      expect(table?.startLine).toBe(0);
      expect(table?.endLine).toBe(4);
    });

    it('accepts alignment markers in the separator row', () => {
      const lines = [
        '| Name | Value |',
        '|:-----|------:|',
        '| foo  | 1     |',
        '| bar  | 2     |',
      ];
      const table = findNextTable(lines, 0);
      expect(table?.headers).toEqual(['Name', 'Value']);
      expect(table?.rows).toEqual([
        ['foo', '1'],
        ['bar', '2'],
      ]);
    });

    it('stops the table on the first non-pipe line', () => {
      const lines = [
        '| Name | Value |',
        '|------|-------|',
        '| foo  | 1     |',
        '',
        '## Heading',
        '| Another | Table |',
      ];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([['foo', '1']]);
      expect(table?.endLine).toBe(3);
    });

    it('ignores pipe lines inside fenced code blocks', () => {
      const lines = [
        'Some prose.',
        '```',
        '| not | a | table |',
        '|-----|---|-------|',
        '```',
        '| Real | Table |',
        '|------|-------|',
        '| yes  | ok    |',
      ];
      const table = findNextTable(lines, 0);
      expect(table?.startLine).toBe(5);
      expect(table?.headers).toEqual(['Real', 'Table']);
    });

    it('returns null when no table is present', () => {
      expect(findNextTable(['no tables here', 'just prose'], 0)).toBeNull();
    });

    it('merges overflow cells into the last column', () => {
      const lines = ['| A | B |', '|---|---|', '| one | two | three |'];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([['one', 'two | three']]);
    });

    it('right-pads short rows with empty cells', () => {
      const lines = ['| A | B | C |', '|---|---|---|', '| one | two |'];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([['one', 'two', '']]);
    });
  });

  describe('findTableByColumns', () => {
    it('selects the first table matching required columns', () => {
      const lines = [
        '| Mode | Count |',
        '|------|-------|',
        '| auto | 2 |',
        '',
        '| Name | Value |',
        '|------|-------|',
        '| foo  | 1 |',
      ];
      const table = findTableByColumns(lines, ['Name', 'Value']);
      expect(table?.headers).toEqual(['Name', 'Value']);
      expect(table?.startLine).toBe(4);
    });

    it('returns null when no table matches', () => {
      const lines = ['| A | B |', '|---|---|', '| 1 | 2 |'];
      expect(findTableByColumns(lines, ['Missing'])).toBeNull();
    });
  });

  describe('findTableAfterHeading', () => {
    it('returns the first table after a matching heading', () => {
      const lines = [
        '# Intro',
        '',
        '## First',
        '| A | B |',
        '|---|---|',
        '| 1 | 2 |',
        '',
        '## Second',
        '| X | Y |',
        '|---|---|',
        '| 3 | 4 |',
      ];
      const table = findTableAfterHeading(lines, /^## Second$/);
      expect(table?.headers).toEqual(['X', 'Y']);
      expect(table?.rows).toEqual([['3', '4']]);
    });
  });

  describe('mutation helpers', () => {
    it('insertRow appends when the index is beyond the end', () => {
      const lines = ['| A | B |', '|---|---|', '| x | y |'];
      const table = findNextTable(lines, 0);
      expect(table).not.toBeNull();
      if (!table) return;
      insertRow(table, ['p', 'q'], Number.POSITIVE_INFINITY);
      expect(table.rows).toEqual([
        ['x', 'y'],
        ['p', 'q'],
      ]);
    });

    it('insertRow inserts at a specific index', () => {
      const lines = ['| A | B |', '|---|---|', '| x | y |', '| m | n |'];
      const table = findNextTable(lines, 0);
      if (!table) throw new Error('table parse failed');
      insertRow(table, ['p', 'q'], 1);
      expect(table.rows.map((r) => r[0])).toEqual(['x', 'p', 'm']);
    });

    it('updateCellByKey updates the first matching row', () => {
      const lines = ['| Mode | Count |', '|------|-------|', '| auto | 2 |', '| static | 1 |'];
      const table = findNextTable(lines, 0);
      if (!table) throw new Error('table parse failed');
      const updated = updateCellByKey(table, 'Mode', 'static', 'Count', '5');
      expect(updated).toBe(true);
      expect(table.rows[1]).toEqual(['static', '5']);
    });

    it('updateCellByKey returns false on unknown columns', () => {
      const lines = ['| Mode | Count |', '|------|-------|', '| auto | 2 |'];
      const table = findNextTable(lines, 0);
      if (!table) throw new Error('table parse failed');
      expect(updateCellByKey(table, 'Missing', 'auto', 'Count', '5')).toBe(false);
      expect(updateCellByKey(table, 'Mode', 'nope', 'Count', '5')).toBe(false);
    });

    it('rewriteTableRows round-trips headers, separator, and rows', () => {
      const lines = ['before', '| A | B |', '|---|---|', '| 1 | 2 |', '| 3 | 4 |', 'after'];
      const table = findNextTable(lines, 0);
      if (!table) throw new Error('table parse failed');
      insertRow(table, ['5', '6'], Number.POSITIVE_INFINITY);
      const rewritten = rewriteTableRows(lines, table);
      expect(rewritten).toEqual([
        'before',
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '| 3 | 4 |',
        '| 5 | 6 |',
        'after',
      ]);
    });
  });

  describe('serializeRow', () => {
    it('wraps cells with leading and trailing pipes', () => {
      expect(serializeRow(['a', 'b', 'c'])).toBe('| a | b | c |');
    });

    it('escapes literal pipes in cell values', () => {
      expect(serializeRow(['a | b', 'c'])).toBe('| a \\| b | c |');
    });

    it('escapes literal backslashes in cell values', () => {
      expect(serializeRow(['a\\b', 'c'])).toBe('| a\\\\b | c |');
    });

    it('escapes a trailing backslash followed by a pipe as `\\\\\\|`', () => {
      // A cell value of `a\|b` (literal backslash then literal pipe) must
      // serialize to `\\\|` so the parser reads it back as `\` + `|`, not
      // as `\|` (which would unescape to a single `|`).
      expect(serializeRow(['a\\|b'])).toBe('| a\\\\\\|b |');
    });
  });

  describe('escape round-trips', () => {
    it('round-trips a cell containing a literal pipe', () => {
      const cells = ['left | middle', 'right'];
      const serialized = serializeRow(cells);
      const lines = ['| Col1 | Col2 |', '|---|---|', serialized];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([cells]);
    });

    it('round-trips a cell containing a literal backslash', () => {
      const cells = ['C:\\path\\to\\file', 'note'];
      const serialized = serializeRow(cells);
      const lines = ['| Path | Note |', '|---|---|', serialized];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([cells]);
    });

    it('round-trips a cell containing backslash followed by literal pipe', () => {
      const cells = ['a\\|b', 'c'];
      const serialized = serializeRow(cells);
      const lines = ['| A | B |', '|---|---|', serialized];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([cells]);
    });

    it('leaves unrelated backslash sequences (e.g. \\n) alone on parse', () => {
      // A backslash followed by something that is neither `|` nor `\`
      // stays literal, so prose-style uses survive untouched.
      const lines = ['| A | B |', '|---|---|', '| line\\nbreak | ok |'];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([['line\\nbreak', 'ok']]);
    });

    it('preserves existing merge-overflow behavior for unescaped malformed rows', () => {
      // Legacy tables written before escape support — an unescaped `|` in
      // a two-column table still parses via the overflow-merge path.
      const lines = ['| A | B |', '|---|---|', '| one | two | three |'];
      const table = findNextTable(lines, 0);
      expect(table?.rows).toEqual([['one', 'two | three']]);
    });
  });
});
