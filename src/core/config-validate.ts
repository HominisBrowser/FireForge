// SPDX-License-Identifier: EUPL-1.2
/**
 * Config schema validation for fireforge.json.
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig, TypecheckConfig } from '../types/config.js';
import { type ParsedRecord, parseObject } from '../utils/parse.js';
import { isContainedRelativePath, isExplicitAbsolutePath } from '../utils/paths.js';
import {
  describeProductVersionIncompatibility,
  FIREFOX_PRODUCTS,
  isValidAppId,
  isValidBinaryName,
  isValidFirefoxCandidate,
  isValidFirefoxProduct,
  isValidFirefoxVersion,
  isValidProjectLicense,
  PROJECT_LICENSES,
} from '../utils/validation.js';
import { SUPPORTED_CONFIG_ROOT_KEYS } from './config-paths.js';
import { parseBuildAuditConfig } from './config-validate-build-audit.js';
import { parseCheckConfig } from './config-validate-check.js';
import { parseExportQueueConfig } from './config-validate-export-queue.js';
import { parseHistoryBlock } from './config-validate-history.js';
import { assertKnownConfigKeys } from './config-validate-keys.js';
import {
  parsePatchLintBlock,
  parseSeverityGate,
  parseShimPath,
} from './config-validate-patch-lint.js';
import { parsePatchPolicyBlock } from './config-validate-patch-policy.js';
import { parseProofConfig } from './config-validate-proof.js';
import { parseBuildRelease, parseSlotsConfig } from './config-validate-slots.js';
import { parseAuthoredSourceConfig } from './config-validate-sources.js';
import { parseExternalToolchainsBlock, parseTestBlock } from './config-validate-test-toolchains.js';

/**
 * Parses and validates the four required identity fields (`name`,
 * `vendor`, `appId`, `binaryName`): all non-empty strings, with
 * `binaryName` additionally barred from path separators/traversal and
 * `appId` required to be a reverse-domain identifier.
 */
function parseIdentityFields(
  rec: ParsedRecord
): Pick<FireForgeConfig, 'name' | 'vendor' | 'appId' | 'binaryName'> {
  // Empty strings would technically pass the
  // typeof-check below but are never valid for any of these identifier
  // fields. Rejecting them here prevents downstream code (Firefox build,
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

  // The rendered mozconfig is shell-evaluated, so the executable name and the
  // free-text fields are restricted to what cannot carry shell syntax.
  if (!isValidBinaryName(binaryName)) {
    throw new ConfigError(
      'Config field "binaryName" must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens'
    );
  }
  for (const [field, value] of [
    ['name', name],
    ['vendor', vendor],
  ] as const) {
    // eslint-disable-next-line no-control-regex -- control characters break out of mozconfig comments
    if (/[\x00-\x1f\x7f]/.test(value)) {
      throw new ConfigError(`Config field "${field}" must not contain control characters`);
    }
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
 * optional sha256 digest (normalized to lowercase), optional
 * `allowUnverifiedDownload` opt-out, optional candidate directory.
 */
function parseFirefoxBlock(rec: ParsedRecord): FireForgeConfig['firefox'] {
  let firefoxRec;
  try {
    firefoxRec = rec.object('firefox');
  } catch {
    throw new ConfigError('Config field "firefox" must be an object');
  }

  assertKnownConfigKeys(
    firefoxRec.keys(),
    ['version', 'product', 'sha256', 'allowUnverifiedDownload', 'candidate'],
    'firefox'
  );
  const firefoxVersion = requireConfigString(firefoxRec, 'version', 'firefox.version');
  if (!isValidFirefoxVersion(firefoxVersion)) {
    throw new ConfigError(
      'Config field "firefox.version" must be a valid Firefox version (e.g., "145.0")'
    );
  }

  const firefoxProduct = requireConfigString(firefoxRec, 'product', 'firefox.product');
  // Uses the shared guard rather than a separate copy of the member list.
  // This is the fireforge.json read path: a product added to the union but
  // not to a local copy would be silently rejected from every project
  // config.
  if (!isValidFirefoxProduct(firefoxProduct)) {
    throw new ConfigError(
      `Config field "firefox.product" must be one of: ${FIREFOX_PRODUCTS.join(', ')}`
    );
  }

  // Cross-field validation: product and version must be compatible
  const compatError = describeProductVersionIncompatibility(firefoxVersion, firefoxProduct);
  if (compatError) {
    throw new ConfigError(compatError);
  }

  const firefoxSha256 = optionalConfigString(firefoxRec, 'sha256', 'firefox.sha256');
  if (firefoxSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(firefoxSha256)) {
    throw new ConfigError(
      'Config field "firefox.sha256" must be a 64-character SHA-256 hex digest'
    );
  }

  const allowUnverifiedDownload = firefoxRec.raw('allowUnverifiedDownload');
  if (allowUnverifiedDownload !== undefined && typeof allowUnverifiedDownload !== 'boolean') {
    throw new ConfigError('Config field "firefox.allowUnverifiedDownload" must be a boolean');
  }

  const firefoxCandidate = optionalConfigString(firefoxRec, 'candidate', 'firefox.candidate');
  if (firefoxCandidate !== undefined && !isValidFirefoxCandidate(firefoxCandidate)) {
    throw new ConfigError(
      'Config field "firefox.candidate" must look like "buildN" (e.g. "build2")'
    );
  }

  return {
    version: firefoxVersion,
    product: firefoxProduct,
    ...(firefoxSha256 !== undefined ? { sha256: firefoxSha256.toLowerCase() } : {}),
    ...(allowUnverifiedDownload !== undefined ? { allowUnverifiedDownload } : {}),
    ...(firefoxCandidate !== undefined ? { candidate: firefoxCandidate } : {}),
  };
}

/** Parses the optional `build` block (currently just `build.jobs`). */
function parseBuildBlock(rec: ParsedRecord, config: FireForgeConfig): void {
  const buildRec = optionalConfigObject(rec, 'build');
  if (buildRec) {
    assertKnownConfigKeys(buildRec.keys(), ['jobs', 'release'], 'build');
    config.build = {};
    const jobs = buildRec.raw('jobs');
    if (jobs !== undefined) {
      if (typeof jobs !== 'number' || !Number.isInteger(jobs) || jobs <= 0) {
        throw new ConfigError('Config field "build.jobs" must be a positive integer');
      }
      config.build.jobs = jobs;
    }
    const release = buildRec.raw('release');
    if (release !== undefined) config.build.release = parseBuildRelease(release);
  }
}

/** Parses the optional `wire` block (currently just `wire.subscriptDir`). */
function parseWireBlock(rec: ParsedRecord, config: FireForgeConfig): void {
  const wireRec = optionalConfigObject(rec, 'wire');
  if (wireRec) {
    assertKnownConfigKeys(wireRec.keys(), ['subscriptDir'], 'wire');
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
function parseLicenseField(rec: ParsedRecord, config: FireForgeConfig): void {
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

  assertKnownConfigKeys(rec.keys(), SUPPORTED_CONFIG_ROOT_KEYS);
  const identity = parseIdentityFields(rec);
  const firefox = parseFirefoxBlock(rec);

  const config: FireForgeConfig = { ...identity, firefox };

  parseBuildBlock(rec, config);
  const slotsRaw = rec.raw('slots');
  if (slotsRaw !== undefined) config.slots = parseSlotsConfig(slotsRaw);
  const buildAuditRaw = rec.raw('buildAudit');
  if (buildAuditRaw !== undefined) {
    config.buildAudit = parseBuildAuditConfig(buildAuditRaw);
  }
  const exportQueueRaw = rec.raw('exportQueue');
  if (exportQueueRaw !== undefined) config.exportQueue = parseExportQueueConfig(exportQueueRaw);
  parseTestBlock(rec, config);
  const sources = rec.raw('sources');
  if (sources !== undefined) {
    config.sources = parseAuthoredSourceConfig(sources);
    if (config.test?.reapOrphans !== 'owned') {
      throw new ConfigError(
        'Authored source mode requires test.reapOrphans="owned" to fence older executables.'
      );
    }
  }
  parseHistoryBlock(rec, config);
  parseExternalToolchainsBlock(rec, config);
  parseWireBlock(rec, config);
  parseLicenseField(rec, config);

  // Marker comment, appended to lines FireForge writes into upstream files.
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

  // Typecheck (top-level, distinct from patchLint). See TypecheckConfig docs.
  const typecheckRec = optionalConfigObject(rec, 'typecheck');
  if (typecheckRec) {
    config.typecheck = parseTypecheckBlock(typecheckRec);
  }

  // `fireforge check` policy and project steps.
  const checkRaw = rec.raw('check');
  if (checkRaw !== undefined) {
    config.check = parseCheckConfig(checkRaw);
  }

  const proofRaw = rec.raw('proof');
  if (proofRaw !== undefined) {
    config.proof = parseProofConfig(proofRaw);
  }

  return config;
}

// ── Internal helpers (wrap parseObject errors with ConfigError) ──

function requireConfigString(rec: ParsedRecord, key: string, label?: string): string {
  const value = rec.raw(key);
  if (typeof value !== 'string') {
    throw new ConfigError(`Config field "${label ?? key}" must be a string`);
  }
  return value;
}

function optionalConfigString(rec: ParsedRecord, key: string, label: string): string | undefined {
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

function optionalConfigObject(rec: ParsedRecord, key: string): ParsedRecord | undefined {
  const value = rec.raw(key);
  if (value === undefined) return undefined;
  try {
    return rec.object(key);
  } catch {
    throw new ConfigError(`Config field "${key}" must be an object`);
  }
}

/**
 * Validates the optional top-level `typecheck` block. Empty `projects`
 * is rejected because a silent no-op for `fireforge typecheck` is a
 * footgun, since operators set the block expecting it to do something. Each
 * project path must be a contained relative path so `--project` / CLI
 * scripts can't escape the project root.
 */
function parseTypecheckBlock(rec: ParsedRecord): TypecheckConfig {
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
      throw new ConfigError(`Config field "typecheck.projects[${i}]" must be a non-empty string`);
    }
    if (!isContainedRelativePath(entry)) {
      throw new ConfigError(
        `Config field "typecheck.projects[${i}]" must be a project-relative path`
      );
    }
    projects.push(entry);
  }

  assertKnownConfigKeys(
    rec.keys(),
    ['projects', 'extraShim', 'projectOverrides', 'undefinedIdentifiers', 'litTypes'],
    'typecheck'
  );
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
  const litTypes = rec.raw('litTypes');
  if (litTypes !== undefined && typeof litTypes !== 'boolean') {
    throw new ConfigError('Config field "typecheck.litTypes" must be a boolean');
  }
  if (litTypes !== undefined) out.litTypes = litTypes;

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
