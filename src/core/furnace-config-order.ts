// SPDX-License-Identifier: EUPL-1.2
import type { FurnaceConfig } from '../types/furnace.js';
import { isObject } from '../utils/validation.js';

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

function orderObjectLikeExisting(
  existing: Record<string, unknown> | undefined,
  next: Record<string, unknown>
): Record<string, unknown> {
  if (!existing) return next;

  const ordered: Record<string, unknown> = {};
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

function orderComponentMapLikeExisting(existing: unknown, next: unknown): unknown {
  if (!isObject(next)) return next;
  if (!isObject(existing)) return next;

  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(existing)) {
    if (Object.hasOwn(next, key)) {
      const existingValue = existing[key];
      const nextValue = next[key];
      ordered[key] =
        isObject(existingValue) && isObject(nextValue)
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
  existing: Record<string, unknown> | undefined,
  config: FurnaceConfig
): Record<string, unknown> {
  const next = config as unknown as Record<string, unknown>;
  if (!existing) return next;

  const ordered: Record<string, unknown> = {};
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
