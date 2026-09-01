// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for `patchLint.fileSizeThresholds`.
 *
 * Split out of `config-validate.ts`, which is at its per-file line budget.
 */

import { ConfigError } from '../errors/config.js';
import type { PatchLintFileSizeThresholds, PatchLintFileSizeTier } from '../types/config.js';
import { isObject } from '../utils/validation.js';
import { DEFAULT_FILE_SIZE_THRESHOLDS } from './patch-lint-file-size.js';

/**
 * Parses one `patchLint.fileSizeThresholds.<tier>` triple. Every field is
 * optional and merges over the built-in default; values must be positive
 * integers and stay ordered `notice <= warning <= error`, because an
 * out-of-order triple would silently disable a band instead of failing.
 */
function parseFileSizeTier(raw: unknown, field: string): PatchLintFileSizeTier {
  if (!isObject(raw)) {
    throw new ConfigError(`Config field "${field}" must be a plain object`);
  }
  const out: PatchLintFileSizeTier = {};
  for (const key of ['notice', 'warning', 'error'] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ConfigError(`Config field "${field}.${key}" must be a positive integer`);
    }
    out[key] = value;
  }
  for (const key of Object.keys(raw)) {
    if (!['notice', 'warning', 'error'].includes(key)) {
      throw new ConfigError(`Config field "${field}" has unknown key "${key}"`);
    }
  }
  return out;
}

/**
 * Parses the `patchLint.fileSizeThresholds` block. Ordering is validated
 * against the MERGED triple (overrides on top of the defaults), so setting
 * only `warning` cannot land below the default `notice`.
 */
export function parsePatchLintFileSizeThresholds(raw: unknown): PatchLintFileSizeThresholds {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "patchLint.fileSizeThresholds" must be a plain object');
  }
  const out: PatchLintFileSizeThresholds = {};
  for (const tier of ['general', 'test'] as const) {
    const value = raw[tier];
    if (value === undefined) continue;
    const parsed = parseFileSizeTier(value, `patchLint.fileSizeThresholds.${tier}`);
    const merged = { ...DEFAULT_FILE_SIZE_THRESHOLDS[tier], ...parsed };
    if (merged.notice > merged.warning || merged.warning > merged.error) {
      throw new ConfigError(
        `Config field "patchLint.fileSizeThresholds.${tier}" must satisfy notice <= warning <= error ` +
          `(resolved: ${String(merged.notice)}/${String(merged.warning)}/${String(merged.error)})`
      );
    }
    out[tier] = parsed;
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'general' && key !== 'test') {
      throw new ConfigError(`Config field "patchLint.fileSizeThresholds" has unknown key "${key}"`);
    }
  }
  return out;
}
