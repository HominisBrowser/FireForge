// SPDX-License-Identifier: EUPL-1.2
/**
 * Section validators for `validateFurnaceConfig`, split out of
 * `furnace-config.ts` to keep that module inside the per-file line
 * budget. Each helper owns one shape: the override entry, the stock
 * list, the named-component maps, and the optional-field tail.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig, OverrideComponentConfig } from '../types/furnace.js';
import { isObject, isString } from '../utils/validation.js';
import { parseStringArray } from './furnace-config-array-utils.js';

/**
 * Validates an override component config object.
 * @param data - Raw data to validate
 * @param name - Component name for error messages
 */
export function parseOverrideConfig(
  data: Record<string, unknown>,
  name: string
): OverrideComponentConfig {
  const validTypes = ['css-only', 'full'];
  if (!isString(data['type']) || !validTypes.includes(data['type'])) {
    throw new FurnaceError(
      `Furnace config: override "${name}.type" must be one of: ${validTypes.join(', ')}`
    );
  }
  if (!isString(data['description'])) {
    throw new FurnaceError(`Furnace config: override "${name}.description" must be a string`);
  }
  if (!isString(data['basePath'])) {
    throw new FurnaceError(`Furnace config: override "${name}.basePath" must be a string`);
  }
  if (data['basePath'].includes('..')) {
    throw new FurnaceError(
      `Furnace config: override "${name}.basePath" must not contain ".." (path traversal)`
    );
  }
  if (!isString(data['baseVersion'])) {
    throw new FurnaceError(`Furnace config: override "${name}.baseVersion" must be a string`);
  }

  return {
    type: data['type'] === 'css-only' ? 'css-only' : 'full',
    description: data['description'],
    basePath: data['basePath'],
    baseVersion: data['baseVersion'],
    ...(isString(data['baseCommit']) ? { baseCommit: data['baseCommit'] } : {}),
  };
}

/**
 * Parses and validates the `stock` component list: lowercase identifiers,
 * no duplicates.
 */
export function parseStockList(raw: unknown): string[] {
  const stock = parseStringArray(raw, 'stock');
  const stockSet = new Set<string>();
  for (const name of stock) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new FurnaceError(
        `Furnace config: stock entry "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, no path separators)`
      );
    }
    if (stockSet.has(name)) {
      throw new FurnaceError(`Furnace config: duplicate stock entry "${name}"`);
    }
    stockSet.add(name);
  }
  return stock;
}

/**
 * Parses one of the named-component maps (`overrides` / `custom`): the
 * map must be an object, every key a lowercase identifier, every value an
 * object handed to the kind-specific parser.
 */
export function parseNamedComponentMap<T>(
  raw: unknown,
  kind: 'override' | 'custom',
  key: 'overrides' | 'custom',
  parse: (value: Record<string, unknown>, name: string) => T
): Record<string, T> {
  if (!isObject(raw)) {
    throw new FurnaceError(`Furnace config: "${key}" must be an object`);
  }
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new FurnaceError(
        `Furnace config: ${kind} name "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, no path separators)`
      );
    }
    if (!isObject(value)) {
      throw new FurnaceError(`Furnace config: ${kind} "${name}" must be an object`);
    }
    out[name] = parse(value, name);
  }
  return out;
}

/**
 * Copies the validated optional fields (token settings, platform
 * prefixes, ftl/jsconfig/scan paths) from the migrated raw config onto
 * the typed config, re-validating the path-shaped ones against
 * traversal.
 */
export function applyOptionalFurnaceFields(
  migrated: Record<string, unknown>,
  config: FurnaceConfig
): void {
  if (migrated['tokenPrefix'] !== undefined && isString(migrated['tokenPrefix'])) {
    config.tokenPrefix = migrated['tokenPrefix'];
  }
  if (migrated['tokenAllowlist'] !== undefined) {
    config.tokenAllowlist = parseStringArray(migrated['tokenAllowlist'], 'tokenAllowlist');
  }
  if (migrated['platformPrefixes'] !== undefined) {
    config.platformPrefixes = parseStringArray(migrated['platformPrefixes'], 'platformPrefixes');
  }
  if (migrated['runtimeVariables'] !== undefined) {
    config.runtimeVariables = parseStringArray(migrated['runtimeVariables'], 'runtimeVariables');
  }
  if (migrated['tokenHostDocuments'] !== undefined) {
    const docs = parseStringArray(migrated['tokenHostDocuments'], 'tokenHostDocuments');
    config.tokenHostDocuments = docs;
  }

  // Validate optional ftlBasePath
  if (migrated['ftlBasePath'] !== undefined) {
    if (!isString(migrated['ftlBasePath'])) {
      throw new FurnaceError('Furnace config: "ftlBasePath" must be a string if provided');
    }
    if (migrated['ftlBasePath'].includes('..')) {
      throw new FurnaceError(
        'Furnace config: "ftlBasePath" must not contain ".." (path traversal)'
      );
    }
    config.ftlBasePath = migrated['ftlBasePath'];
  }

  // Validate optional typecheckJsconfig — consumer-owned jsconfig whose
  // chrome-elements `paths` entries Furnace maintains on deploy.
  if (migrated['typecheckJsconfig'] !== undefined) {
    const jsconfigPath = migrated['typecheckJsconfig'];
    if (!isString(jsconfigPath) || jsconfigPath.includes('..')) {
      throw new FurnaceError(
        'Furnace config: "typecheckJsconfig" must be a string without ".." (path traversal)'
      );
    }
    config.typecheckJsconfig = jsconfigPath;
  }

  // Validate optional scanPaths
  if (migrated['scanPaths'] !== undefined) {
    const paths = parseStringArray(migrated['scanPaths'], 'scanPaths');
    for (const p of paths) {
      if (p.includes('..')) {
        throw new FurnaceError(
          'Furnace config: "scanPaths" entries must not contain ".." (path traversal)'
        );
      }
    }
    config.scanPaths = paths;
  }
}
