// SPDX-License-Identifier: EUPL-1.2
/**
 * Config schema validation for fireforge.json.
 */

import { ConfigError } from '../errors/config.js';
import type {
  FireForgeConfig,
  PatchLintCheckJsCompilerOptions,
  PatchLintSeverityGate,
  TypecheckConfig,
} from '../types/config.js';
import { verbose } from '../utils/logger.js';
import { parseObject } from '../utils/parse.js';
import { isContainedRelativePath, isExplicitAbsolutePath } from '../utils/paths.js';
import {
  isValidAppId,
  isValidFirefoxVersion,
  isValidProjectLicense,
  PROJECT_LICENSES,
  validateFirefoxProductVersionCompatibility,
} from '../utils/validation.js';
import { SUPPORTED_CONFIG_ROOT_KEYS } from './config-paths.js';
import { parsePatchPolicyBlock } from './config-validate-patch-policy.js';

/**
 * Validates a raw config object and returns a typed FireForgeConfig.
 * @param data - Raw data to validate
 * @returns Validated FireForgeConfig
 * @throws Error if validation fails
 */
export function validateConfig(data: unknown): FireForgeConfig {
  let rec;
  try {
    rec = parseObject(data, 'Config');
  } catch {
    throw new ConfigError('Config must be an object');
  }

  // Required string fields. Empty strings would technically pass the
  // typeof-check below but are never valid for any of these identifier
  // fields — rejecting them here prevents downstream code (Firefox build,
  // launcher binary lookup, AppID assertions) from failing with confusing
  // errors much later.
  const name = requireConfigString(rec, 'name');
  const vendor = requireConfigString(rec, 'vendor');
  const appId = requireConfigString(rec, 'appId');
  const binaryName = requireConfigString(rec, 'binaryName');

  for (const [field, value] of [
    ['name', name],
    ['vendor', vendor],
    ['appId', appId],
    ['binaryName', binaryName],
  ] as const) {
    if (value.trim() === '') {
      throw new ConfigError(`Config field "${field}" must not be empty`);
    }
  }

  if (
    binaryName.includes('..') ||
    binaryName.includes('/') ||
    binaryName.includes('\\') ||
    binaryName.includes('\0')
  ) {
    throw new ConfigError(
      'Config field "binaryName" must not contain path separators, "..", or null bytes'
    );
  }

  if (isExplicitAbsolutePath(binaryName)) {
    throw new ConfigError('Config field "binaryName" must not be an absolute path');
  }

  if (!isValidAppId(appId)) {
    throw new ConfigError(
      'Config field "appId" must be a valid reverse-domain identifier (e.g., "org.example.browser")'
    );
  }

  // Firefox config
  let firefoxRec;
  try {
    firefoxRec = rec.object('firefox');
  } catch {
    throw new ConfigError('Config field "firefox" must be an object');
  }

  const firefoxVersion = requireConfigString(firefoxRec, 'version', 'firefox.version');
  if (!isValidFirefoxVersion(firefoxVersion)) {
    throw new ConfigError(
      'Config field "firefox.version" must be a valid Firefox version (e.g., "145.0")'
    );
  }

  const firefoxProduct = requireConfigString(firefoxRec, 'product', 'firefox.product');
  const validProducts = ['firefox', 'firefox-esr', 'firefox-beta', 'firefox-devedition'];
  if (!validProducts.includes(firefoxProduct)) {
    throw new ConfigError(
      `Config field "firefox.product" must be one of: ${validProducts.join(', ')}`
    );
  }

  // Cross-field validation: product and version must be compatible
  const compatError = validateFirefoxProductVersionCompatibility(firefoxVersion, firefoxProduct);
  if (compatError) {
    throw new ConfigError(compatError);
  }

  const firefoxSha256 = optionalConfigString(firefoxRec, 'sha256', 'firefox.sha256');
  if (firefoxSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(firefoxSha256)) {
    throw new ConfigError(
      'Config field "firefox.sha256" must be a 64-character SHA-256 hex digest'
    );
  }

  // Optional configs
  const config: FireForgeConfig = {
    name,
    vendor,
    appId,
    binaryName,
    firefox: {
      version: firefoxVersion,
      product: firefoxProduct as FireForgeConfig['firefox']['product'],
      ...(firefoxSha256 !== undefined ? { sha256: firefoxSha256.toLowerCase() } : {}),
    },
  };

  // Build
  const buildRec = optionalConfigObject(rec, 'build');
  if (buildRec) {
    config.build = {};
    const jobs = buildRec.raw('jobs');
    if (jobs !== undefined) {
      if (typeof jobs !== 'number' || !Number.isInteger(jobs) || jobs <= 0) {
        throw new ConfigError('Config field "build.jobs" must be a positive integer');
      }
      config.build.jobs = jobs;
    }
  }

  // Wire
  const wireRec = optionalConfigObject(rec, 'wire');
  if (wireRec) {
    config.wire = {};
    const subscriptDir = optionalConfigString(wireRec, 'subscriptDir', 'wire.subscriptDir');
    if (subscriptDir !== undefined) {
      if (!isContainedRelativePath(subscriptDir)) {
        throw new ConfigError('Config field "wire.subscriptDir" must stay within engine/');
      }
      config.wire.subscriptDir = subscriptDir;
    }
  }

  // License
  const licenseRaw = rec.raw('license');
  if (licenseRaw !== undefined) {
    if (typeof licenseRaw !== 'string') {
      throw new ConfigError('Config field "license" must be a string');
    }
    if (!isValidProjectLicense(licenseRaw)) {
      throw new ConfigError(
        `Config field "license" must be one of: ${PROJECT_LICENSES.join(', ')}`
      );
    }
    config.license = licenseRaw;
  }

  // Marker comment — appended to lines FireForge writes into upstream files.
  const markerComment = parseMarkerComment(rec.raw('markerComment'));
  if (markerComment !== undefined) {
    config.markerComment = markerComment;
  }

  // PatchLint
  const patchLintRec = optionalConfigObject(rec, 'patchLint');
  if (patchLintRec) {
    config.patchLint = parsePatchLintBlock(patchLintRec);
  }

  // PatchPolicy
  const patchPolicyRec = optionalConfigObject(rec, 'patchPolicy');
  if (patchPolicyRec) {
    config.patchPolicy = parsePatchPolicyBlock(patchPolicyRec);
  }

  // Typecheck (top-level, distinct from patchLint — see TypecheckConfig docs).
  const typecheckRec = optionalConfigObject(rec, 'typecheck');
  if (typecheckRec) {
    config.typecheck = parseTypecheckBlock(typecheckRec);
  }

  // Warn on unknown root keys
  const knownRootKeys = new Set<string>(SUPPORTED_CONFIG_ROOT_KEYS);
  for (const key of rec.keys()) {
    if (!knownRootKeys.has(key)) {
      verbose(`Unknown config key "${key}" in fireforge.json — it will be ignored.`);
    }
  }

  return config;
}

// ── Internal helpers (wrap parseObject errors with ConfigError) ──

function requireConfigString(
  rec: ReturnType<typeof parseObject>,
  key: string,
  label?: string
): string {
  const value = rec.raw(key);
  if (typeof value !== 'string') {
    throw new ConfigError(`Config field "${label ?? key}" must be a string`);
  }
  return value;
}

function optionalConfigString(
  rec: ReturnType<typeof parseObject>,
  key: string,
  label: string
): string | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new ConfigError(`Config field "${label}" must be a string`);
  }
  return value;
}

/**
 * Validates a raw `markerComment` value. Rejected values: non-strings, empty
 * strings, surrounding whitespace (ambiguous format), newlines (would break
 * source formatting), and `*&#47;` (would terminate an enclosing block comment
 * downstream). Control characters are rejected for the same reason.
 */
function parseMarkerComment(raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    throw new ConfigError('Config field "markerComment" must be a string');
  }
  if (raw.trim() === '') {
    throw new ConfigError('Config field "markerComment" must not be empty');
  }
  if (raw !== raw.trim()) {
    throw new ConfigError(
      'Config field "markerComment" must not have leading or trailing whitespace'
    );
  }
  if (/[\n\r]/.test(raw) || raw.includes('*/')) {
    throw new ConfigError('Config field "markerComment" must not contain newlines or "*/"');
  }
  // eslint-disable-next-line no-control-regex -- intentionally rejecting control chars
  if (/[\x00-\x1f]/.test(raw)) {
    throw new ConfigError('Config field "markerComment" must not contain control characters');
  }
  return raw;
}

function optionalConfigObject(
  rec: ReturnType<typeof parseObject>,
  key: string
): ReturnType<typeof parseObject> | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  try {
    return rec.object(key);
  } catch {
    throw new ConfigError(`Config field "${key}" must be an object`);
  }
}

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

function parsePatchLintCheckJsCompilerOptions(raw: unknown): PatchLintCheckJsCompilerOptions {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('Config field "patchLint.checkJsCompilerOptions" must be a plain object');
  }
  const rec = raw as Record<string, unknown>;
  const allowed = new Set<string>(PATCH_LINT_CHECKJS_COMPILER_OPTION_KEYS);
  const out: PatchLintCheckJsCompilerOptions = {};
  for (const key of Object.keys(rec)) {
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

function parseSeverityGate(raw: unknown, label: string): PatchLintSeverityGate | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !(SEVERITY_GATE_VALUES as readonly string[]).includes(raw)) {
    throw new ConfigError(
      `Config field "${label}" must be one of: ${SEVERITY_GATE_VALUES.join(', ')}`
    );
  }
  return raw as PatchLintSeverityGate;
}

function parsePatchLintBlock(
  rec: ReturnType<typeof parseObject>
): NonNullable<FireForgeConfig['patchLint']> {
  const out: NonNullable<FireForgeConfig['patchLint']> = {};

  const checkJs = rec.raw('checkJs');
  if (checkJs !== undefined) {
    if (typeof checkJs !== 'boolean') {
      throw new ConfigError('Config field "patchLint.checkJs" must be a boolean');
    }
    out.checkJs = checkJs;
  }

  const checkJsStrict = rec.raw('checkJsStrict');
  if (checkJsStrict !== undefined) {
    if (typeof checkJsStrict !== 'boolean') {
      throw new ConfigError('Config field "patchLint.checkJsStrict" must be a boolean');
    }
    out.checkJsStrict = checkJsStrict;
  }

  const checkJsCompilerOptionsRaw = rec.raw('checkJsCompilerOptions');
  if (checkJsCompilerOptionsRaw !== undefined) {
    out.checkJsCompilerOptions = parsePatchLintCheckJsCompilerOptions(checkJsCompilerOptionsRaw);
  }

  const checkJsExtraShim = rec.raw('checkJsExtraShim');
  if (checkJsExtraShim !== undefined) {
    out.checkJsExtraShim = parseShimPath(checkJsExtraShim, 'patchLint.checkJsExtraShim');
  }

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

  const jsdocClassMethods = parseSeverityGate(
    rec.raw('jsdocClassMethods'),
    'patchLint.jsdocClassMethods'
  );
  if (jsdocClassMethods !== undefined) {
    out.jsdocClassMethods = jsdocClassMethods;
  }

  const testAssertionFloor = parseSeverityGate(
    rec.raw('testAssertionFloor'),
    'patchLint.testAssertionFloor'
  );
  if (testAssertionFloor !== undefined) {
    out.testAssertionFloor = testAssertionFloor;
  }

  const chromeScriptJsDoc = parseSeverityGate(
    rec.raw('chromeScriptJsDoc'),
    'patchLint.chromeScriptJsDoc'
  );
  if (chromeScriptJsDoc !== undefined) {
    out.chromeScriptJsDoc = chromeScriptJsDoc;
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

  return out;
}

/**
 * Validates a path field that should point at a project-relative `.d.ts`
 * file. Shared between `patchLint.checkJsExtraShim` and
 * `typecheck.extraShim` so both fields reject the same absolute-path /
 * traversal / empty-string inputs with consistent error messages. The
 * file's existence is intentionally not checked here — that lives at
 * the engine layer where a missing file produces a typed runtime error
 * pointing at the actual command, rather than blocking config reads
 * for unrelated commands.
 */
function parseShimPath(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ConfigError(`Config field "${label}" must be a non-empty string`);
  }
  if (!isContainedRelativePath(raw)) {
    throw new ConfigError(`Config field "${label}" must be a project-relative path`);
  }
  return raw;
}

/**
 * Validates the optional top-level `typecheck` block. Empty `projects`
 * is rejected because a silent no-op for `fireforge typecheck` is a
 * footgun — operators set the block expecting it to do something. Each
 * project path must be a contained relative path so `--project` / CLI
 * scripts can't escape the project root.
 */
function parseTypecheckBlock(rec: ReturnType<typeof parseObject>): TypecheckConfig {
  const projectsRaw = rec.raw('projects');
  if (projectsRaw === undefined) {
    throw new ConfigError('Config field "typecheck.projects" is required when "typecheck" is set');
  }
  if (!Array.isArray(projectsRaw)) {
    throw new ConfigError('Config field "typecheck.projects" must be an array of strings');
  }
  if (projectsRaw.length === 0) {
    throw new ConfigError('Config field "typecheck.projects" must not be empty');
  }
  const projects: string[] = [];
  for (let i = 0; i < projectsRaw.length; i++) {
    const entry: unknown = projectsRaw[i];
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(
        `Config field "typecheck.projects[${String(i)}]" must be a non-empty string`
      );
    }
    if (!isContainedRelativePath(entry)) {
      throw new ConfigError(
        `Config field "typecheck.projects[${String(i)}]" must be a project-relative path`
      );
    }
    projects.push(entry);
  }

  const out: TypecheckConfig = { projects };

  const extraShim = rec.raw('extraShim');
  if (extraShim !== undefined) {
    out.extraShim = parseShimPath(extraShim, 'typecheck.extraShim');
  }

  return out;
}
