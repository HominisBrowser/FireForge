// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for `fireforge.json#patchLint.tokenScales`.
 */

import { ConfigError } from '../errors/config.js';
import type { PatchLintTokenScale } from '../types/config.js';
import { parseObject } from '../utils/parse.js';

function parseNames(raw: unknown, label: string, required: boolean): string[] | undefined {
  if (raw === undefined && !required) return undefined;
  if (
    !Array.isArray(raw) ||
    (required && raw.length === 0) ||
    raw.some((value) => typeof value !== 'string' || value.trim() === '')
  ) {
    throw new ConfigError(
      `Config field "${label}" must be ${required ? 'a non-empty' : 'an'} array of non-empty strings`
    );
  }
  return raw as string[];
}

function parseTokenScale(raw: unknown, label: string): PatchLintTokenScale {
  let rec;
  try {
    rec = parseObject(raw, label);
  } catch {
    throw new ConfigError(`Config field "${label}" must be an object`);
  }
  const properties = parseNames(rec.raw('properties'), `${label}.properties`, true) ?? [];
  const prefix = rec.raw('prefix');
  if (typeof prefix !== 'string' || !/^--[\w-]+$/.test(prefix)) {
    throw new ConfigError(
      `Config field "${label}.prefix" must be a custom-property prefix such as "--mybrowser-space-"`
    );
  }
  const scale: PatchLintTokenScale = { properties, prefix };
  const allowLiterals = parseNames(rec.raw('allowLiterals'), `${label}.allowLiterals`, false);
  if (allowLiterals !== undefined) scale.allowLiterals = allowLiterals;
  const allow = parseNames(rec.raw('allow'), `${label}.allow`, false);
  if (allow !== undefined) {
    const malformed = allow.find((name) => !name.startsWith('--'));
    if (malformed !== undefined) {
      throw new ConfigError(
        `Config field "${label}.allow" entries must be custom-property names starting with "--" (got "${malformed}")`
      );
    }
    scale.allow = allow;
  }
  return scale;
}

/** Parses and validates `patchLint.tokenScales`. */
export function parsePatchLintTokenScales(raw: unknown): PatchLintTokenScale[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError('Config field "patchLint.tokenScales" must be an array');
  }
  return raw.map((entry, index) => parseTokenScale(entry, `patchLint.tokenScales[${index}]`));
}
