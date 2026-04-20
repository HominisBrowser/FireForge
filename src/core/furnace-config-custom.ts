// SPDX-License-Identifier: EUPL-1.2
/**
 * Parser for the `custom` entries in furnace.json. Extracted from
 * `furnace-config.ts` so the main config module stays under the
 * per-file LOC budget — the custom-component schema has grown to
 * carry opt-in fields (`composes`, `keyboardCovered`, `sharedFtl`) that
 * each add their own validation branch.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { CustomComponentConfig } from '../types/furnace.js';
import { isExplicitAbsolutePath } from '../utils/paths.js';
import { isBoolean, isString } from '../utils/validation.js';
import { parseStringArray } from './furnace-config.js';
import { validateSharedFtl } from './shared-ftl.js';

/**
 * Validates a custom component config object.
 * @param data - Raw data to validate
 * @param name - Component name for error messages
 */
export function parseCustomConfig(
  data: Record<string, unknown>,
  name: string
): CustomComponentConfig {
  if (!isString(data['description'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.description" must be a string`);
  }
  if (!isString(data['targetPath'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.targetPath" must be a string`);
  }
  if (data['targetPath'].includes('..') || data['targetPath'].includes('\0')) {
    throw new FurnaceError(
      `Furnace config: custom "${name}.targetPath" must not contain ".." or null bytes (path traversal)`
    );
  }
  if (isExplicitAbsolutePath(data['targetPath'])) {
    throw new FurnaceError(
      `Furnace config: custom "${name}.targetPath" must not be an absolute path`
    );
  }
  if (!isBoolean(data['register'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.register" must be a boolean`);
  }
  if (!isBoolean(data['localized'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.localized" must be a boolean`);
  }
  if (data['composes'] !== undefined) {
    parseStringArray(data['composes'], `${name}.composes`);
  }
  if (data['keyboardCovered'] !== undefined && !isBoolean(data['keyboardCovered'])) {
    throw new FurnaceError(
      `Furnace config: custom "${name}.keyboardCovered" must be a boolean when set`
    );
  }
  let sharedFtl: string | undefined;
  if (data['sharedFtl'] !== undefined) {
    const result = validateSharedFtl(data['sharedFtl'], { localized: data['localized'] });
    if (!result.ok) {
      throw new FurnaceError(`Furnace config: custom "${name}.sharedFtl" ${result.reason}`);
    }
    sharedFtl = result.value;
  }

  return {
    description: data['description'],
    targetPath: data['targetPath'],
    register: data['register'],
    localized: data['localized'],
    ...(data['composes'] !== undefined
      ? { composes: parseStringArray(data['composes'], `${name}.composes`) }
      : {}),
    ...(data['keyboardCovered'] === true ? { keyboardCovered: true } : {}),
    ...(sharedFtl !== undefined ? { sharedFtl } : {}),
  };
}
