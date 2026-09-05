// SPDX-License-Identifier: EUPL-1.2
/**
 * Small validation helpers for furnace.json token-related fields. Extracted
 * from `furnace-config.ts` so the main config module stays under the per-file
 * LOC budget.
 */

import { FurnaceError } from '../errors/furnace.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { parseStringArray } from './furnace-config-array-utils.js';

/**
 * Validates a `tokenHostDocuments` raw value. Each entry must be a non-empty
 * relative path contained in the engine tree. Throws `FurnaceError` on
 * violation. Does nothing for `undefined` (field is optional).
 */
export function validateTokenHostDocuments(raw: unknown): void {
  if (raw === undefined) return;
  const docs = parseStringArray(raw, 'tokenHostDocuments');
  for (const doc of docs) {
    if (doc.trim() === '') {
      throw new FurnaceError(
        'Furnace config: "tokenHostDocuments" entries must be non-empty strings'
      );
    }
    if (!isContainedRelativePath(doc)) {
      throw new FurnaceError(
        `Furnace config: "tokenHostDocuments" entry "${doc}" must stay within the engine tree (no absolute paths, no "..")`
      );
    }
  }
}

/**
 * Validates a `runtimeVariables` raw value. Each entry must start with `--`
 * (it is a CSS custom property name). Throws `FurnaceError` on violation.
 * Does nothing for `undefined` (field is optional).
 */
export function validateRuntimeVariables(raw: unknown): void {
  if (raw === undefined) return;
  const vars = parseStringArray(raw, 'runtimeVariables');
  for (const name of vars) {
    if (!name.startsWith('--')) {
      throw new FurnaceError(
        `Furnace config: "runtimeVariables" entries must start with "--" (got ${JSON.stringify(name)})`
      );
    }
  }
}
