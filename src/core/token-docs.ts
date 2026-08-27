// SPDX-License-Identifier: EUPL-1.2
/**
 * Documentation-table updates for `fireforge token add`. Extracted from
 * `token-manager.ts` so the CSS-mutation path and the Markdown-table path
 * each stay within the per-file line budget. Consumed only by token-manager.
 */

import { join } from 'node:path';

import { pathExists, readText, writeText } from '../utils/fs.js';
import {
  findTableAfterHeading,
  findTableByColumns,
  insertRow,
  rewriteTableRows,
  updateCellByKey,
} from './markdown-table.js';

const TOKENS_DOC = 'docs/design/SRC_TOKENS.md';

/**
 * Minimal token shape the docs updater needs. Declared locally (rather than
 * importing `AddTokenOptions`) so this module has no edge back to
 * `token-manager.ts` — `AddTokenOptions` is structurally compatible.
 */
export interface TokenDocInput {
  tokenName: string;
  value: string;
  category: string;
  mode: string;
  description?: string | undefined;
}

/**
 * Strips surrounding backticks from a cell, if present. Token cells are
 * usually wrapped in inline code fences (`` `--foo` ``) and the parser
 * returns them verbatim.
 */
function stripInlineCode(cell: string): string {
  const trimmed = cell.trim();
  if (trimmed.startsWith('`') && trimmed.endsWith('`') && trimmed.length >= 2) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Adds a token row to the main token table, the unmapped table (for
 * literal values), and bumps the mode count table. Each sub-update runs
 * against a freshly parsed view of the document so that splice indices
 * stay valid as rewrites are layered.
 *
 * @param engineDir - Absolute path to the engine checkout
 * @param options - Token name, category and description to document
 * @param annotation - The mode annotation string the caller already computed
 *   (kept here as a parameter so this module needs no dependency on
 *   token-manager's `getModeAnnotation`).
 */
export async function addTokenToDocs(
  engineDir: string,
  options: TokenDocInput,
  annotation: string
): Promise<{ docsAdded: boolean; unmappedAdded: boolean; countUpdated: boolean }> {
  const filePath = join(engineDir, '..', TOKENS_DOC);

  if (!(await pathExists(filePath))) {
    // Docs file is optional
    return { docsAdded: false, unmappedAdded: false, countUpdated: false };
  }

  const originalContent = await readText(filePath);
  let lines = originalContent.split('\n');

  let docsAdded = false;
  let unmappedAdded = false;
  let countUpdated = false;

  const isLiteral = !options.value.startsWith('var(');
  const mapsTo = isLiteral ? '—' : options.value.replace(/^var\(([^)]+)\)/, '$1');
  const tokenCell = `\`${options.tokenName}\``;
  const valueCell = `\`${options.value}\``;

  // --- Main token table: Category | Token | Value | Maps to | Mode ---
  const mainTable = findTableByColumns(lines, ['Category', 'Token', 'Value', 'Mode']);
  if (mainTable) {
    // The doc convention allows the Category cell to be blank on
    // continuation rows that belong to the previous category. Group rows
    // by carrying the last non-empty Category value forward.
    let lastGroupRowIndex = -1;
    let currentCategory = '';
    for (let i = 0; i < mainTable.rows.length; i++) {
      const row = mainTable.rows[i];
      if (!row) continue;
      const cell = row[0]?.trim() ?? '';
      if (cell) {
        currentCategory = cell;
      }
      if (currentCategory === options.category) {
        lastGroupRowIndex = i;
      }
    }

    if (lastGroupRowIndex !== -1) {
      insertRow(mainTable, ['', tokenCell, valueCell, mapsTo, annotation], lastGroupRowIndex + 1);
      lines = rewriteTableRows(lines, mainTable);
      docsAdded = true;
    }
  }

  // --- Unmapped table: populated for literal (non-var()) values only ---
  if (isLiteral) {
    const unmappedTable = findTableAfterHeading(lines, /not yet mapped|unmapped/i);
    if (unmappedTable) {
      insertRow(
        unmappedTable,
        [tokenCell, valueCell, options.description ?? ''],
        unmappedTable.rows.length
      );
      lines = rewriteTableRows(lines, unmappedTable);
      unmappedAdded = true;
    }
  }

  // --- Mode behavior count table: Mode | Count ---
  const modeTable = findTableByColumns(lines, ['Mode', 'Count']);
  if (modeTable) {
    const modeIndex = modeTable.headers.indexOf('Mode');
    const countIndex = modeTable.headers.indexOf('Count');
    const existing = modeTable.rows.find(
      (row) => stripInlineCode(row[modeIndex] ?? '') === options.mode
    );
    if (existing) {
      const oldCount = parseInt(existing[countIndex] ?? '0', 10);
      const updated = updateCellByKey(
        modeTable,
        'Mode',
        existing[modeIndex] ?? options.mode,
        'Count',
        String((Number.isNaN(oldCount) ? 0 : oldCount) + 1)
      );
      if (updated) {
        lines = rewriteTableRows(lines, modeTable);
        countUpdated = true;
      }
    }
  }

  await writeText(filePath, lines.join('\n'));

  return { docsAdded, unmappedAdded, countUpdated };
}
