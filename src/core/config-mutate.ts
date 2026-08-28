// SPDX-License-Identifier: EUPL-1.2
/**
 * Immutable config mutation with dot-path keys.
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { isJsonObject, isObject } from '../utils/validation.js';
import { validateConfig } from './config-validate.js';

function cloneConfigDocument(config: FireForgeConfig | JsonObject): JsonObject {
  const cloned: unknown = structuredClone(config);
  if (!isObject(cloned)) {
    throw new ConfigError('Config clone unexpectedly produced a non-object value');
  }

  // Both input shapes hold only JSON data (`FireForgeConfig` is plain
  // parsed-config data), and `structuredClone` preserves that, so the
  // object check above is the only invariant left to establish.
  return cloned as JsonObject;
}

/**
 * The error every sentinel-segment refusal raises. Only the MESSAGE lives
 * here: the comparison itself is spelled inline at each write site, because
 * that is what both a reader and CodeQL's `js/prototype-pollution-utility`
 * barrier detection need — the latter is not interprocedural, so a check
 * hidden behind a helper leaves the descent below looking unguarded.
 */
function sentinelSegmentError(key: string, part: string): ConfigError {
  return new ConfigError(
    `Config key "${key}" contains a reserved segment "${part}". ` +
      'Segments "__proto__", "constructor", and "prototype" are not permitted ' +
      'because they would mutate the object prototype chain.'
  );
}

function getOrCreateChildRecord(parent: JsonObject, key: string): JsonObject {
  const existing = parent[key];
  if (isJsonObject(existing)) {
    return existing;
  }

  const child: JsonObject = {};
  parent[key] = child;
  return child;
}

/**
 * Creates a mutated copy of a config with a nested key set to a new value,
 * optionally re-validated.
 * @param config - Original config
 * @param key - Dot-separated config path
 * @param value - New value
 * @param skipValidation - If true, skip re-validation (for --force)
 * @returns The mutated config
 */
export function mutateConfig(
  config: FireForgeConfig,
  key: string,
  value: JsonValue,
  skipValidation?: false
): FireForgeConfig;
export function mutateConfig(
  config: FireForgeConfig | JsonObject,
  key: string,
  value: JsonValue,
  skipValidation: true
): JsonObject;
export function mutateConfig(
  config: FireForgeConfig | JsonObject,
  key: string,
  value: JsonValue,
  skipValidation = false
): FireForgeConfig | JsonObject {
  const parts = key.split('.');
  const raw = cloneConfigDocument(config);

  // Every segment is checked at the point it is USED as a property name —
  // the descent below and the leaf assignment — rather than once up front,
  // so `--force` cannot be used to mutate Object.prototype and neither write
  // can drift out from behind the guard. `raw` is a private clone, so a
  // refusal here has mutated nothing the caller can observe.
  let current: JsonObject = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw sentinelSegmentError(key, part);
    }
    current = getOrCreateChildRecord(current, part);
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart !== undefined) {
    if (lastPart === '__proto__' || lastPart === 'constructor' || lastPart === 'prototype') {
      throw sentinelSegmentError(key, lastPart);
    }
    current[lastPart] = value;
  }

  if (!skipValidation) {
    return validateConfig(raw);
  }

  try {
    validateConfig(raw);
  } catch (error: unknown) {
    verbose(
      `Skipping config revalidation for forced mutation on "${key}": ${toError(error).message}`
    );
  }

  return raw;
}
