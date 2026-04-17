// SPDX-License-Identifier: EUPL-1.2
/**
 * Small validation helpers for furnace.json token-related fields. Extracted
 * from `furnace-config.ts` so the main config module stays under the per-file
 * LOC budget.
 */

import { FurnaceError } from '../errors/furnace.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { parseStringArray } from './furnace-config.js';

/**
 * Validates a `tokenHostDocuments` raw value. Each entry must be a non-empty
 * relative path contained in the engine tree. Throws `FurnaceError` on
 * violation; does nothing for `undefined` (field is optional).
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
