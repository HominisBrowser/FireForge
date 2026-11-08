// SPDX-License-Identifier: EUPL-1.2
/**
 * Validation for the `patchLint` block of fireforge.json and the shared
 * severity-gate and shim-path field parsers.
 */

import { ConfigError } from '../errors/config.js';
import type {
  FireForgeConfig,
  PatchLintCheckJsCompilerOptions,
  PatchLintSeverityGate,
} from '../types/config.js';
import { type ParsedRecord } from '../utils/parse.js';
import { isContainedRelativePath } from '../utils/paths.js';
import { isObject } from '../utils/validation.js';
import { parsePatchLintSizeFields } from './config-validate-file-size.js';
import { assertKnownConfigKeys } from './config-validate-keys.js';
import { parsePatchLintTokenScales } from './config-validate-token-scales.js';

const SEVERITY_GATE_VALUES: readonly PatchLintSeverityGate[] = ['off', 'warning', 'error'];

/** Allowlisted keys for `patchLint.checkJsCompilerOptions` (boolean overrides only). */
const PATCH_LINT_CHECKJS_COMPILER_OPTION_KEYS = [
  'strictNullChecks',
  'strictFunctionTypes',
  'strictBindCallApply',
  'noImplicitThis',
  'useUnknownInCatchVariables',
  'strictPropertyInitialization',
  'noUnusedLocals',
  'noUnusedParameters',
] as const satisfies readonly (keyof PatchLintCheckJsCompilerOptions)[];

/**
 * Validates the reviewed `paths` mapping: an object of pattern → string[]
 * targets, each pattern carrying at most one `*`. Lets patch-owned modules
 * be typed from their real sources without an ambient stub shim.
 */
function parseCheckJsPathsMapping(raw: unknown): Record<string, string[]> {
  if (!isObject(raw)) {
    throw new ConfigError(
      'Config field "patchLint.checkJsCompilerOptions.paths" must be a plain object'
    );
  }
  const rec = raw;
  const out: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(rec)) {
    if ((pattern.match(/\*/g) ?? []).length > 1) {
      throw new ConfigError(
        `Config field "patchLint.checkJsCompilerOptions.paths" key "${pattern}" may contain at most one "*"`
      );
    }
    if (!Array.isArray(targets) || targets.some((t: unknown) => typeof t !== 'string')) {
      throw new ConfigError(
        `Config field "patchLint.checkJsCompilerOptions.paths.${pattern}" must be an array of strings`
      );
    }
    out[pattern] = targets as string[];
  }
  return out;
}

function parsePatchLintCheckJsCompilerOptions(raw: unknown): PatchLintCheckJsCompilerOptions {
  if (!isObject(raw)) {
    throw new ConfigError('Config field "patchLint.checkJsCompilerOptions" must be a plain object');
  }
  const rec = raw;
  const allowed = new Set<string>(PATCH_LINT_CHECKJS_COMPILER_OPTION_KEYS);
  const out: PatchLintCheckJsCompilerOptions = {};
  for (const key of Object.keys(rec)) {
    if (key === 'paths') {
      out.paths = parseCheckJsPathsMapping(rec[key]);
      continue;
    }
    if (!allowed.has(key)) {
      throw new ConfigError(
        `Config field "patchLint.checkJsCompilerOptions" has unknown key "${key}"`
      );
    }
    const val = rec[key];
    if (typeof val !== 'boolean') {
      throw new ConfigError(
        `Config field "patchLint.checkJsCompilerOptions.${key}" must be a boolean`
      );
    }
    (out as Record<string, boolean>)[key] = val;
  }
  return out;
}

/** Validates one `off | warning | error` severity gate; undefined when absent. */
export function parseSeverityGate(raw: unknown, label: string): PatchLintSeverityGate | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(SEVERITY_GATE_VALUES as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `Config field "${label}" must be one of: ${SEVERITY_GATE_VALUES.join(', ')}`
    );
  }
  return raw as PatchLintSeverityGate;
}

/**
 * Reads an optional boolean `patchLint` field, rejecting a non-boolean with
 * the field-named message. Three identical inline copies of this shape were
 * part of what held `parsePatchLintBlock` at complexity 25/30.
 */
function optionalPatchLintBoolean(rec: ParsedRecord, key: string): boolean | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`Config field "patchLint.${key}" must be a boolean`);
  }
  return value;
}

/** Severity-gate fields, each parsed and assigned identically. */
const PATCH_LINT_SEVERITY_GATE_KEYS = [
  'prettier',
  'jsdocClassMethods',
  'testAssertionFloor',
  'chromeScriptJsDoc',
  'undefinedIdentifiers',
] as const;

const PATCH_LINT_KEYS = [
  'checkJs',
  'checkJsStrict',
  'checkJsCompilerOptions',
  'checkJsExtraShim',
  'checkJsTestFiles',
  'checkJsTestShim',
  'litTypes',
  'rawColorAllowlist',
  'fileSizeThresholds',
  'fileSizeMetric',
  'patchSizeThresholds',
  'patchSizeMetric',
  'patchSizeRegistrationFiles',
  'forwardRegistration',
  'tokenScales',
  ...PATCH_LINT_SEVERITY_GATE_KEYS,
] as const;

/** Validates the `patchLint` block, rejecting unknown keys and inconsistent flag combinations. */
export function parsePatchLintBlock(rec: ParsedRecord): NonNullable<FireForgeConfig['patchLint']> {
  assertKnownConfigKeys(rec.keys(), PATCH_LINT_KEYS, 'patchLint');
  const out: NonNullable<FireForgeConfig['patchLint']> = {};

  const checkJs = optionalPatchLintBoolean(rec, 'checkJs');
  if (checkJs !== undefined) out.checkJs = checkJs;

  const checkJsStrict = optionalPatchLintBoolean(rec, 'checkJsStrict');
  if (checkJsStrict !== undefined) out.checkJsStrict = checkJsStrict;

  const checkJsCompilerOptionsRaw = rec.raw('checkJsCompilerOptions');
  if (checkJsCompilerOptionsRaw !== undefined) {
    out.checkJsCompilerOptions = parsePatchLintCheckJsCompilerOptions(checkJsCompilerOptionsRaw);
  }

  const checkJsExtraShim = rec.raw('checkJsExtraShim');
  if (checkJsExtraShim !== undefined) {
    out.checkJsExtraShim = parseShimPath(checkJsExtraShim, 'patchLint.checkJsExtraShim');
  }

  const checkJsTestFiles = optionalPatchLintBoolean(rec, 'checkJsTestFiles');
  if (checkJsTestFiles !== undefined) out.checkJsTestFiles = checkJsTestFiles;

  const checkJsTestShim = rec.raw('checkJsTestShim');
  if (checkJsTestShim !== undefined) {
    out.checkJsTestShim = parseShimPath(checkJsTestShim, 'patchLint.checkJsTestShim');
  }

  const litTypes = optionalPatchLintBoolean(rec, 'litTypes');
  if (litTypes !== undefined) out.litTypes = litTypes;

  const rawColorAllowlist = rec.raw('rawColorAllowlist');
  if (rawColorAllowlist !== undefined) {
    if (
      !Array.isArray(rawColorAllowlist) ||
      rawColorAllowlist.some((v: unknown) => typeof v !== 'string')
    ) {
      throw new ConfigError(
        'Config field "patchLint.rawColorAllowlist" must be an array of strings'
      );
    }
    out.rawColorAllowlist = rawColorAllowlist as string[];
  }

  Object.assign(
    out,
    parsePatchLintSizeFields((key) => rec.raw(key))
  );

  const forwardRegistration = rec.raw('forwardRegistration');
  if (forwardRegistration !== undefined) {
    if (forwardRegistration !== 'support-files' && forwardRegistration !== 'extended') {
      throw new ConfigError(
        'Config field "patchLint.forwardRegistration" must be one of: support-files, extended'
      );
    }
    out.forwardRegistration = forwardRegistration;
  }

  const tokenScales = rec.raw('tokenScales');
  if (tokenScales !== undefined) out.tokenScales = parsePatchLintTokenScales(tokenScales);

  for (const key of PATCH_LINT_SEVERITY_GATE_KEYS) {
    const gate = parseSeverityGate(rec.raw(key), `patchLint.${key}`);
    if (gate !== undefined) out[key] = gate;
  }

  if (out.checkJsStrict === true && out.checkJs !== true) {
    throw new ConfigError(
      'Config field "patchLint.checkJsStrict" requires "patchLint.checkJs": true'
    );
  }
  if (out.checkJsCompilerOptions !== undefined && out.checkJsStrict !== true) {
    throw new ConfigError(
      'Config field "patchLint.checkJsCompilerOptions" requires "patchLint.checkJsStrict": true'
    );
  }
  if (out.checkJsTestFiles === true && out.checkJs !== true) {
    throw new ConfigError(
      'Config field "patchLint.checkJsTestFiles" requires "patchLint.checkJs": true'
    );
  }
  if (out.checkJsTestShim !== undefined && out.checkJsTestFiles !== true) {
    throw new ConfigError(
      'Config field "patchLint.checkJsTestShim" requires "patchLint.checkJsTestFiles": true'
    );
  }
  if (out.litTypes === true && out.checkJs !== true) {
    throw new ConfigError('Config field "patchLint.litTypes" requires "patchLint.checkJs": true');
  }

  return out;
}

/**
 * Validates a path field that should point at a project-relative `.d.ts`
 * file. Shared between `patchLint.checkJsExtraShim` and
 * `typecheck.extraShim` so both fields reject the same absolute-path /
 * traversal / empty-string inputs with consistent error messages. The
 * file's existence is not checked here. That lives at the engine layer,
 * where a missing file produces a typed runtime error pointing at the
 * actual command, rather than blocking config reads for unrelated commands.
 */
export function parseShimPath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(`Config field "${label}" must be a non-empty string`);
  }
  if (!isContainedRelativePath(raw)) {
    throw new ConfigError(`Config field "${label}" must be a project-relative path`);
  }
  return raw;
}
