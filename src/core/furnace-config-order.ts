// SPDX-License-Identifier: EUPL-1.2
import type { FurnaceConfig } from '../types/furnace.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { isJsonObject } from '../utils/validation.js';

const FURNACE_CONFIG_TOP_LEVEL_KEYS = new Set([
  'version',
  'componentPrefix',
  'tokenPrefix',
  'tokenAllowlist',
  'platformPrefixes',
  'runtimeVariables',
  'tokenHostDocuments',
  'ftlBasePath',
  'scanPaths',
  'stock',
  'overrides',
  'custom',
]);

function orderObjectLikeExisting(existing: JsonObject | undefined, next: JsonObject): JsonObject {
  if (!existing) return next;

  const ordered: JsonObject = {};
  for (const key of Object.keys(existing)) {
    if (Object.hasOwn(next, key)) {
      ordered[key] = next[key];
    }
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(ordered, key)) {
      ordered[key] = next[key];
    }
  }
  return ordered;
}

function orderComponentMapLikeExisting(
  existing: JsonValue | undefined,
  next: JsonValue | undefined
): JsonValue | undefined {
  if (!isJsonObject(next)) return next;
  if (!isJsonObject(existing)) return next;

  const ordered: JsonObject = {};
  for (const key of Object.keys(existing)) {
    if (Object.hasOwn(next, key)) {
      const existingValue = existing[key];
      const nextValue = next[key];
      ordered[key] =
        isJsonObject(existingValue) && isJsonObject(nextValue)
          ? orderObjectLikeExisting(existingValue, nextValue)
          : nextValue;
    }
  }
  for (const key of Object.keys(next)) {
    if (!Object.hasOwn(ordered, key)) {
      ordered[key] = next[key];
    }
  }
  return ordered;
}

/**
 * Orders furnace.json output using the existing file as the primary key
 * sequence, preserving unknown extension keys and appending newly supported
 * fields only when needed.
 */
export function orderFurnaceConfigForWrite(
  existing: JsonObject | undefined,
  config: FurnaceConfig
): JsonObject {
  // FurnaceConfig is plain parsed-JSON data, but as an interface it carries
  // no index signature, so the compiler cannot verify the JsonObject
  // contract structurally, hence the double assertion. This is the one
  // place a typed furnace config re-enters the raw-document world.
  // eslint-disable-next-line no-restricted-syntax -- see above
  const next = config as unknown as JsonObject;
  if (!existing) return next;

  const ordered: JsonObject = {};
  for (const key of Object.keys(existing)) {
    if (key === 'overrides' || key === 'custom') {
      ordered[key] = orderComponentMapLikeExisting(existing[key], next[key]);
    } else if (Object.hasOwn(next, key)) {
      ordered[key] = next[key];
    } else if (!FURNACE_CONFIG_TOP_LEVEL_KEYS.has(key)) {
      ordered[key] = existing[key];
    }
  }

  for (const key of Object.keys(next)) {
    if (Object.hasOwn(ordered, key)) continue;
    ordered[key] =
      key === 'overrides' || key === 'custom'
        ? orderComponentMapLikeExisting(existing[key], next[key])
        : next[key];
  }

  return ordered;
}
