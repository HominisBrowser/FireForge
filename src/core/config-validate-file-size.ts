// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for the size-rule keys of `patchLint`: `fileSizeThresholds`,
 * `fileSizeMetric`, `patchSizeThresholds`, `patchSizeMetric` and
 * `patchSizeRegistrationFiles`.
 *
 * Split out of `config-validate.ts`, which is at its per-file line budget.
 */

import { ConfigError } from '../errors/config.js';
import type {
  PatchLintConfig,
  PatchLintFileSizeThresholds,
  PatchLintFileSizeTier,
  PatchLintPatchSizeThresholds,
  PatchLintPatchSizeTier,
} from '../types/config.js';
import { isObject } from '../utils/validation.js';
import { DEFAULT_FILE_SIZE_THRESHOLDS } from './patch-lint-file-size.js';
import {
  type PatchSizeTierName,
  resolvePatchSizeThresholds,
} from './patch-lint-size-thresholds.js';

/**
 * Parses one `patchLint.fileSizeThresholds.<tier>` triple. Every field is
 * optional and merges over the built-in default. Values must be positive
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
 * against the merged triple (overrides on top of the defaults), so setting
 * only `warning` cannot land below the default `notice`.
 */
function parsePatchLintFileSizeThresholds(raw: unknown): PatchLintFileSizeThresholds {
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
          `(resolved: ${merged.notice}/${merged.warning}/${merged.error})`
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

/** Throws unless `merged` is ordered `notice <= warning <= error` (a `null` error is unbounded). */
function assertOrderedTriple(
  merged: { notice: number; warning: number; error: number | null },
  field: string
): void {
  if (merged.notice > merged.warning || (merged.error !== null && merged.warning > merged.error)) {
    throw new ConfigError(
      `Config field "${field}" must satisfy notice <= warning <= error ` +
        `(resolved: ${merged.notice}/${merged.warning}/${merged.error ?? 'none'})`
    );
  }
}

/**
 * Parses one `patchLint.patchSizeThresholds.<tier>` entry: optional
 * `lines` and `files` triples, each validated against its merged result.
 */
function parsePatchSizeTier(raw: unknown, tier: PatchSizeTierName): PatchLintPatchSizeTier {
  const field = `patchLint.patchSizeThresholds.${tier}`;
  if (!isObject(raw)) {
    throw new ConfigError(`Config field "${field}" must be a plain object`);
  }
  const out: PatchLintPatchSizeTier = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'lines' && key !== 'files') {
      throw new ConfigError(`Config field "${field}" has unknown key "${key}"`);
    }
    out[key] = parseFileSizeTier(raw[key], `${field}.${key}`);
  }
  const merged = resolvePatchSizeThresholds(tier, { [tier]: out });
  assertOrderedTriple(merged.lines, `${field}.lines`);
  assertOrderedTriple(merged.files, `${field}.files`);
  return out;
}

/** Parses the `patchLint.patchSizeThresholds` block. */
function parsePatchLintPatchSizeThresholds(raw: unknown): PatchLintPatchSizeThresholds {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "patchLint.patchSizeThresholds" must be a plain object');
  }
  const out: PatchLintPatchSizeThresholds = {};
  for (const key of Object.keys(raw)) {
    if (key !== 'general' && key !== 'test' && key !== 'branding') {
      throw new ConfigError(
        `Config field "patchLint.patchSizeThresholds" has unknown key "${key}"`
      );
    }
    out[key] = parsePatchSizeTier(raw[key], key);
  }
  return out;
}

/** Parses an enum-valued `patchLint` key, naming the allowed values on failure. */
function parseEnum<T extends string>(raw: unknown, field: string, values: readonly T[]): T {
  if (typeof raw !== 'string' || !(values as readonly string[]).includes(raw)) {
    throw new ConfigError(`Config field "${field}" must be one of: ${values.join(', ')}`);
  }
  return raw as T;
}

/**
 * Parses every size-rule key of the `patchLint` block.
 *
 * @param read - Reads one raw `patchLint` field by key
 * @returns The parsed fields, only those present
 */
export function parsePatchLintSizeFields(
  read: (key: string) => unknown
): Pick<
  PatchLintConfig,
  | 'fileSizeThresholds'
  | 'fileSizeMetric'
  | 'patchSizeThresholds'
  | 'patchSizeMetric'
  | 'patchSizeRegistrationFiles'
> {
  const out: ReturnType<typeof parsePatchLintSizeFields> = {};
  const fileSizeThresholds = read('fileSizeThresholds');
  if (fileSizeThresholds !== undefined) {
    out.fileSizeThresholds = parsePatchLintFileSizeThresholds(fileSizeThresholds);
  }
  const fileSizeMetric = read('fileSizeMetric');
  if (fileSizeMetric !== undefined) {
    out.fileSizeMetric = parseEnum(fileSizeMetric, 'patchLint.fileSizeMetric', ['raw', 'code']);
  }
  const patchSizeThresholds = read('patchSizeThresholds');
  if (patchSizeThresholds !== undefined) {
    out.patchSizeThresholds = parsePatchLintPatchSizeThresholds(patchSizeThresholds);
  }
  const patchSizeMetric = read('patchSizeMetric');
  if (patchSizeMetric !== undefined) {
    out.patchSizeMetric = parseEnum(patchSizeMetric, 'patchLint.patchSizeMetric', [
      'diff',
      'addedCode',
    ]);
  }
  const registration = read('patchSizeRegistrationFiles');
  if (registration !== undefined) {
    if (
      !Array.isArray(registration) ||
      registration.some((v: unknown) => typeof v !== 'string' || v.trim() === '')
    ) {
      throw new ConfigError(
        'Config field "patchLint.patchSizeRegistrationFiles" must be an array of non-empty strings'
      );
    }
    out.patchSizeRegistrationFiles = registration as string[];
  }
  return out;
}
