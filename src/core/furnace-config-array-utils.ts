// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared string-array parsing for furnace.json validation. Lives in its own
 * module so `furnace-config-custom.ts` and `furnace-config-tokens.ts` can use
 * it without importing `furnace-config.ts`, which would create import cycles.
 */

import { FurnaceError } from '../errors/furnace.js';
import { isArray, isString } from '../utils/validation.js';

/**
 * Parses a JSON array-of-strings field from raw furnace config data.
 * @param value - Raw value from JSON
 * @param fieldName - Field label for error messages
 */
export function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!isArray(value)) {
    throw new FurnaceError(`Furnace config: "${fieldName}" must be an array`);
  }

  const items: string[] = [];
  for (const item of value) {
    if (!isString(item)) {
      throw new FurnaceError(`Furnace config: "${fieldName}" array must contain only strings`);
    }
    items.push(item);
  }

  return items;
}
