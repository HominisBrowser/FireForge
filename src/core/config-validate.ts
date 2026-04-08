// SPDX-License-Identifier: EUPL-1.2
/**
 * Config schema validation for fireforge.json.
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig, ProjectLicense } from '../types/config.js';
import { verbose } from '../utils/logger.js';
import { parseObject } from '../utils/parse.js';
import { isContainedRelativePath } from '../utils/paths.js';
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

  // Required string fields
  const name = requireConfigString(rec, 'name');
  const vendor = requireConfigString(rec, 'vendor');
  const appId = requireConfigString(rec, 'appId');
  const binaryName = requireConfigString(rec, 'binaryName');

  if (binaryName.includes('..') || binaryName.includes('/') || binaryName.includes('\\')) {
    throw new ConfigError('Config field "binaryName" must not contain path separators or ".."');
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
    config.license = licenseRaw as ProjectLicense;
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
