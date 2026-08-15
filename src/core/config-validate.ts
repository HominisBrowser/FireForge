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
  isObject,
  isValidAppId,
  isValidFirefoxCandidate,
  isValidFirefoxVersion,
  isValidProjectLicense,
  PROJECT_LICENSES,
  validateFirefoxProductVersionCompatibility,
} from '../utils/validation.js';
import { SUPPORTED_CONFIG_ROOT_KEYS } from './config-paths.js';
import { parsePatchPolicyBlock } from './config-validate-patch-policy.js';
import { parseExternalToolchainsBlock, parseTestBlock } from './config-validate-test-toolchains.js';

/**
 * Parses and validates the four required identity fields (`name`,
 * `vendor`, `appId`, `binaryName`): all non-empty strings, with
 * `binaryName` additionally barred from path separators/traversal and
 * `appId` required to be a reverse-domain identifier.
 */
function parseIdentityFields(
  rec: ReturnType<typeof parseObject>
): Pick<FireForgeConfig, 'name' | 'vendor' | 'appId' | 'binaryName'> {
  // Empty strings would technically pass the
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

  return { name, vendor, appId, binaryName };
}

/**
 * Parses and validates the required `firefox` block: version shape,
 * product allowlist, product/version cross-compatibility, and the
 * optional sha256 digest (normalized to lowercase).
 */
function parseFirefoxBlock(rec: ReturnType<typeof parseObject>): FireForgeConfig['firefox'] {
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

  const firefoxCandidate = optionalConfigString(firefoxRec, 'candidate', 'firefox.candidate');
  if (firefoxCandidate !== undefined && !isValidFirefoxCandidate(firefoxCandidate)) {
    throw new ConfigError(
      'Config field "firefox.candidate" must look like "buildN" (e.g. "build2")'
    );
  }

  return {
    version: firefoxVersion,
    product: firefoxProduct as FireForgeConfig['firefox']['product'],
    ...(firefoxSha256 !== undefined ? { sha256: firefoxSha256.toLowerCase() } : {}),
    ...(firefoxCandidate !== undefined ? { candidate: firefoxCandidate } : {}),
  };
}

/** Parses the optional `build` block (currently just `build.jobs`). */
function parseBuildBlock(rec: ReturnType<typeof parseObject>, config: FireForgeConfig): void {
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
}

/** Parses the optional `wire` block (currently just `wire.subscriptDir`). */
function parseWireBlock(rec: ReturnType<typeof parseObject>, config: FireForgeConfig): void {
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
}

/** Parses the optional `license` field against the supported-license list. */
function parseLicenseField(rec: ReturnType<typeof parseObject>, config: FireForgeConfig): void {
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
}

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

  const identity = parseIdentityFields(rec);
  const firefox = parseFirefoxBlock(rec);

  const config: FireForgeConfig = { ...identity, firefox };

  parseBuildBlock(rec, config);
  parseTestBlock(rec, config);
  parseExternalToolchainsBlock(rec, config);
  parseWireBlock(rec, config);
  parseLicenseField(rec, config);

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

function parseSeverityGate(raw: unknown, label: string): PatchLintSeverityGate | undefined {
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
function optionalPatchLintBoolean(
  rec: ReturnType<typeof parseObject>,
  key: string
): boolean | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ConfigError(`Config field "patchLint.${key}" must be a boolean`);
  }
  return value;
}

/** Severity-gate fields, each parsed and assigned identically. */
const PATCH_LINT_SEVERITY_GATE_KEYS = [
  'jsdocClassMethods',
  'testAssertionFloor',
  'chromeScriptJsDoc',
  'undefinedIdentifiers',
] as const;

function parsePatchLintBlock(
  rec: ReturnType<typeof parseObject>
): NonNullable<FireForgeConfig['patchLint']> {
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

  const overrides = parseTypecheckProjectOverrides(rec.raw('projectOverrides'), projects);
  if (overrides) {
    out.projectOverrides = overrides;
  }

  const undefinedIdentifiers = parseSeverityGate(
    rec.raw('undefinedIdentifiers'),
    'typecheck.undefinedIdentifiers'
  );
  if (undefinedIdentifiers !== undefined) {
    out.undefinedIdentifiers = undefinedIdentifiers;
  }

  return out;
}

/**
 * Validates the optional `typecheck.projectOverrides` map: keys must name a
 * declared project, values must be either `null` (opt out of the shared extra
 * shim) or a contained relative `.d.ts` path (per-project override). Returns
 * `undefined` when the field is absent.
 */
function parseTypecheckProjectOverrides(
  raw: unknown,
  projects: readonly string[]
): Record<string, string | null> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('Config field "typecheck.projectOverrides" must be an object');
  }
  const known = new Set(projects);
  const out: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) {
      throw new ConfigError(
        `Config field "typecheck.projectOverrides" key "${key}" does not match any entry in "typecheck.projects"`
      );
    }
    out[key] = value === null ? null : parseShimPath(value, `typecheck.projectOverrides["${key}"]`);
  }
  return out;
}
