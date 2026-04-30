// SPDX-License-Identifier: EUPL-1.2
/**
 * Config schema validation for fireforge.json.
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig, PatchLintSeverityGate } from '../types/config.js';
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
  const validProducts = ['firefox', 'firefox-esr', 'firefox-beta'];
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

  // Optional configs
  const config: FireForgeConfig = {
    name,
    vendor,
    appId,
    binaryName,
    firefox: {
      version: firefoxVersion,
      product: firefoxProduct as FireForgeConfig['firefox']['product'],
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

  return out;
}
