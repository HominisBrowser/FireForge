// SPDX-License-Identifier: EUPL-1.2
/**
 * Section validators for `validateFurnaceConfig`, split out of
 * `furnace-config.ts` to keep that module inside the per-file line
 * budget. Each helper owns one shape: the override entry, the stock
 * list, the named-component maps, and the optional-field tail.
 */

import { FurnaceError } from '../errors/furnace.js';
import type { FurnaceConfig, OverrideComponentConfig } from '../types/furnace.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { isJsonObject, isString } from '../utils/validation.js';
import { parseStringArray } from './furnace-config-array-utils.js';
import {
  parseMinComponents,
  parseOptInChecks,
  parseTokenSiblingSheets,
  parseValidationExceptions,
} from './furnace-config-validate-exceptions.js';

/**
 * Validates an override component config object.
 * @param data - Raw data to validate
 * @param name - Component name for error messages
 */
export function parseOverrideConfig(data: JsonObject, name: string): OverrideComponentConfig {
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
  raw: JsonValue | undefined,
  kind: 'override' | 'custom',
  key: 'overrides' | 'custom',
  parse: (value: JsonObject, name: string) => T
): Record<string, T> {
  if (!isJsonObject(raw)) {
    throw new FurnaceError(`Furnace config: "${key}" must be an object`);
  }
  const out: Record<string, T> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new FurnaceError(
        `Furnace config: ${kind} name "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, no path separators)`
      );
    }
    if (!isJsonObject(value)) {
      throw new FurnaceError(`Furnace config: ${kind} "${name}" must be an object`);
    }
    out[name] = parse(value, name);
  }
  return out;
}

/**
 * Validates `typecheckJsconfig`: one path, or a non-empty list of distinct
 * paths, none with `..`. A one-entry list stays a list.
 */
function parseTypecheckJsconfig(raw: JsonValue): string | string[] {
  const message =
    'Furnace config: "typecheckJsconfig" must be a path or a non-empty array of distinct ' +
    'paths, without ".." (path traversal)';
  const paths = isString(raw) ? [raw] : Array.isArray(raw) ? raw : undefined;
  if (
    paths === undefined ||
    paths.length === 0 ||
    paths.some((path) => !isString(path) || path.includes('..')) ||
    new Set(paths).size !== paths.length
  ) {
    throw new FurnaceError(message);
  }
  return isString(raw) ? raw : (paths as string[]);
}

/**
 * Copies the validated optional fields (token settings, platform
 * prefixes, ftl/jsconfig/scan paths) from the migrated raw config onto
 * the typed config, re-validating the path-shaped ones against
 * traversal.
 */
export function applyOptionalFurnaceFields(migrated: JsonObject, config: FurnaceConfig): void {
  if (migrated['tokenPrefix'] !== undefined && isString(migrated['tokenPrefix'])) {
    config.tokenPrefix = migrated['tokenPrefix'];
  }
  if (migrated['tokenAllowlist'] !== undefined) {
    config.tokenAllowlist = parseStringArray(migrated['tokenAllowlist'], 'tokenAllowlist');
  }
  if (migrated['platformPrefixes'] !== undefined) {
    config.platformPrefixes = parseStringArray(migrated['platformPrefixes'], 'platformPrefixes');
  }
  if (migrated['tokenSiblingSheets'] !== undefined) {
    config.tokenSiblingSheets = parseTokenSiblingSheets(migrated['tokenSiblingSheets']);
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

  // Validate optional typecheckJsconfig: one or more consumer-owned
  // jsconfigs whose chrome-elements `paths` entries Furnace maintains on
  // deploy.
  if (migrated['typecheckJsconfig'] !== undefined) {
    config.typecheckJsconfig = parseTypecheckJsconfig(migrated['typecheckJsconfig']);
  }

  // Validate optional typecheckTagMap, the generated tag-map declaration.
  if (migrated['typecheckTagMap'] !== undefined) {
    const tagMap = migrated['typecheckTagMap'];
    if (!isString(tagMap) || tagMap.includes('..') || !tagMap.endsWith('.d.ts')) {
      throw new FurnaceError(
        'Furnace config: "typecheckTagMap" must be a ".d.ts" path without ".." (path traversal)'
      );
    }
    config.typecheckTagMap = tagMap;
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

  // `furnace validate` policy: reviewed exceptions and opt-in checks.
  if (migrated['validationExceptions'] !== undefined) {
    config.validationExceptions = parseValidationExceptions(migrated['validationExceptions']);
  }
  if (migrated['optInChecks'] !== undefined) {
    config.optInChecks = parseOptInChecks(migrated['optInChecks']);
  }
  if (migrated['minComponents'] !== undefined) {
    config.minComponents = parseMinComponents(migrated['minComponents']);
  }
}
