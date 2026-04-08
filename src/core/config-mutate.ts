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

function cloneConfigDocument(config: FireForgeConfig): Record<string, unknown> {
  const cloned: unknown = structuredClone(config);
  if (!isObject(cloned)) {
    throw new ConfigError('Config clone unexpectedly produced a non-object value');
  }

  return cloned;
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
  config: FireForgeConfig,
  key: string,
  value: unknown,
  skipValidation: true
): Record<string, unknown>;
export function mutateConfig(
  config: FireForgeConfig,
  key: string,
  value: unknown,
  skipValidation = false
): FireForgeConfig | Record<string, unknown> {
  const raw = cloneConfigDocument(config);

  const parts = key.split('.');
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
