// SPDX-License-Identifier: EUPL-1.2
/**
 * Immutable config mutation with dot-path keys.
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { isObject } from '../utils/validation.js';
import { validateConfig } from './config-validate.js';

function cloneConfigDocument(
  config: FireForgeConfig | Record<string, unknown>
): Record<string, unknown> {
  const cloned: unknown = structuredClone(config);
  if (!isObject(cloned)) {
    throw new ConfigError('Config clone unexpectedly produced a non-object value');
  }

  return cloned;
}

/**
 * Key segments that would walk into or rewrite the object prototype chain
 * if used as plain property names. Blocked up-front so the descent in
 * {@link mutateConfig} cannot be weaponized to mutate `Object.prototype`
 * process-wide — e.g. `fireforge config __proto__.polluted 1 --force`
 * would otherwise land in `getOrCreateChildRecord(raw, "__proto__")`.
 */
const SENTINEL_KEY_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

function assertNoSentinelSegments(key: string, parts: string[]): void {
  for (const part of parts) {
    if (SENTINEL_KEY_SEGMENTS.has(part)) {
      throw new ConfigError(
        `Config key "${key}" contains a reserved segment "${part}". ` +
          'Segments "__proto__", "constructor", and "prototype" are not permitted ' +
          'because they would mutate the object prototype chain.'
      );
    }
  }
}

function getOrCreateChildRecord(
  parent: Record<string, unknown>,
  key: string
): Record<string, unknown> {
  const existing = parent[key];
  if (isObject(existing)) {
    return existing;
  }

  const child: Record<string, unknown> = {};
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
  value: unknown,
  skipValidation?: false
): FireForgeConfig;
export function mutateConfig(
  config: FireForgeConfig | Record<string, unknown>,
  key: string,
  value: unknown,
  skipValidation: true
): Record<string, unknown>;
export function mutateConfig(
  config: FireForgeConfig | Record<string, unknown>,
  key: string,
  value: unknown,
  skipValidation = false
): FireForgeConfig | Record<string, unknown> {
  const parts = key.split('.');
  // Reject prototype-chain sentinel segments before any write so
  // `--force` cannot be used to mutate Object.prototype. This guard must
  // run against the original key parts, not any subset — the final leaf
  // assignment `current[lastPart] = value` would otherwise stay vulnerable.
  assertNoSentinelSegments(key, parts);

  const raw = cloneConfigDocument(config);

  let current: Record<string, unknown> = raw;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined) continue;
    current = getOrCreateChildRecord(current, part);
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart !== undefined) {
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
