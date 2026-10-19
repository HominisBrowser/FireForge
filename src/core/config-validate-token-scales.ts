// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for `fireforge.json#patchLint.tokenScales`.
 *
 * Unknown keys are refused: a misspelt `allowInCalc` or `minFiles` would
 * otherwise loosen or drop a scale without a word.
 */

import { ConfigError } from '../errors/config.js';
import type { PatchLintTokenScale } from '../types/config.js';
import { parseObject } from '../utils/parse.js';

const SCALE_KEYS = [
  'properties',
  'prefix',
  'allowLiterals',
  'allow',
  'allowInCalc',
  'offsetCap',
  'exclude',
  'minFiles',
];

const PREFIX_PATTERN = /^--[\w-]+$/;

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

function parsePrefix(raw: unknown, label: string): string | string[] {
  const prefixes = Array.isArray(raw) ? (raw as unknown[]) : [raw];
  if (
    prefixes.length === 0 ||
    prefixes.some((prefix) => typeof prefix !== 'string' || !PREFIX_PATTERN.test(prefix))
  ) {
    throw new ConfigError(
      `Config field "${label}.prefix" must be a custom-property prefix such as "--mybrowser-space-", or a non-empty list of them`
    );
  }
  return Array.isArray(raw) ? (prefixes as string[]) : (raw as string);
}

function parseNumber(raw: unknown, label: string, integer: boolean): number {
  const valid =
    typeof raw === 'number' && Number.isFinite(raw) && (integer ? Number.isInteger(raw) : true);
  if (!valid || raw < (integer ? 1 : 0)) {
    throw new ConfigError(
      `Config field "${label}" must be ${integer ? 'a positive integer' : 'a non-negative number'}`
    );
  }
  return raw;
}

function parseTokenScale(raw: unknown, label: string): PatchLintTokenScale {
  let rec;
  try {
    rec = parseObject(raw, label);
  } catch {
    throw new ConfigError(`Config field "${label}" must be an object`);
  }
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!SCALE_KEYS.includes(key)) {
      throw new ConfigError(`Config field "${label}" has unknown key "${key}"`);
    }
  }
  const properties = parseNames(rec.raw('properties'), `${label}.properties`, true) ?? [];
  const scale: PatchLintTokenScale = { properties, prefix: parsePrefix(rec.raw('prefix'), label) };
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
  const allowInCalc = parseNames(rec.raw('allowInCalc'), `${label}.allowInCalc`, false);
  if (allowInCalc !== undefined) scale.allowInCalc = allowInCalc;
  const offsetCap = rec.raw('offsetCap');
  if (offsetCap !== undefined)
    scale.offsetCap = parseNumber(offsetCap, `${label}.offsetCap`, false);
  const exclude = parseNames(rec.raw('exclude'), `${label}.exclude`, false);
  if (exclude !== undefined) scale.exclude = exclude;
  const minFiles = rec.raw('minFiles');
  if (minFiles !== undefined) scale.minFiles = parseNumber(minFiles, `${label}.minFiles`, true);
  return scale;
}

/** Parses and validates `patchLint.tokenScales`. */
export function parsePatchLintTokenScales(raw: unknown): PatchLintTokenScale[] {
  if (!Array.isArray(raw)) {
    throw new ConfigError('Config field "patchLint.tokenScales" must be an array');
  }
  return raw.map((entry, index) => parseTokenScale(entry, `patchLint.tokenScales[${index}]`));
}
