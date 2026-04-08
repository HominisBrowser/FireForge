// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  CustomComponentConfig,
  FurnaceConfig,
  FurnaceState,
  OverrideComponentConfig,
} from '../types/furnace.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { isArray, isBoolean, isObject, isString } from '../utils/validation.js';
import { FIREFORGE_DIR } from './config.js';
import { quarantineStateFile, withStateFileLock } from './state-file.js';

/** Name of the furnace configuration file */
export const FURNACE_CONFIG_FILENAME = 'furnace.json';

/** Name of the furnace state file */
export const FURNACE_STATE_FILENAME = 'furnace-state.json';

/** Name of the components directory */
export const COMPONENTS_DIR = 'components';

/** Name of the overrides subdirectory */
export const OVERRIDES_DIR = 'overrides';

/** Name of the custom subdirectory */
export const CUSTOM_DIR = 'custom';

/**
 * Paths for furnace-related files and directories.
 */
interface FurnacePaths {
  /** Path to furnace.json */
  furnaceConfig: string;
  /** Path to components directory */
  componentsDir: string;
  /** Path to components/overrides directory */
  overridesDir: string;
  /** Path to components/custom directory */
  customDir: string;
  /** Path to .fireforge/furnace-state.json */
  furnaceState: string;
}

/**
 * Gets all furnace-related paths based on a root directory.
 * @param root - Root directory of the project
 * @returns All furnace paths
 */
export function getFurnacePaths(root: string): FurnacePaths {
  const componentsDir = join(root, COMPONENTS_DIR);
  return {
    furnaceConfig: join(root, FURNACE_CONFIG_FILENAME),
    componentsDir,
    overridesDir: join(componentsDir, OVERRIDES_DIR),
    customDir: join(componentsDir, CUSTOM_DIR),
    furnaceState: join(root, FIREFORGE_DIR, FURNACE_STATE_FILENAME),
  };
}

/**
 * Checks if a furnace.json exists in the given directory.
 * @param root - Root directory to check
 * @returns True if furnace.json exists
 */
export async function furnaceConfigExists(root: string): Promise<boolean> {
  const paths = getFurnacePaths(root);
  return pathExists(paths.furnaceConfig);
}

/**
 * Validates an override component config object.
 * @param data - Raw data to validate
 * @param name - Component name for error messages
 */
function parseStringArray(value: unknown, fieldName: string): string[] {
  if (!isArray(value)) {
    throw new FurnaceError(`Furnace config: "${fieldName}" must be an array`);
  }

  const items: string[] = [];
  for (const item of value) {
    if (!isString(item)) {
      throw new FurnaceError(`Furnace config: "${fieldName}" array must contain only strings`);
    }
    items.push(item);
  }

  return items;
}

function parseOverrideConfig(data: Record<string, unknown>, name: string): OverrideComponentConfig {
  const validTypes = ['css-only', 'full'];
  if (!isString(data['type']) || !validTypes.includes(data['type'])) {
    throw new FurnaceError(
      `Furnace config: override "${name}.type" must be one of: ${validTypes.join(', ')}`
    );
  }
  if (!isString(data['description'])) {
    throw new FurnaceError(`Furnace config: override "${name}.description" must be a string`);
  }
  if (!isString(data['basePath'])) {
    throw new FurnaceError(`Furnace config: override "${name}.basePath" must be a string`);
  }
  if (data['basePath'].includes('..')) {
    throw new FurnaceError(
      `Furnace config: override "${name}.basePath" must not contain ".." (path traversal)`
    );
  }
  if (!isString(data['baseVersion'])) {
    throw new FurnaceError(`Furnace config: override "${name}.baseVersion" must be a string`);
  }

  return {
    type: data['type'] === 'css-only' ? 'css-only' : 'full',
    description: data['description'],
    basePath: data['basePath'],
    baseVersion: data['baseVersion'],
  };
}

/**
 * Validates a custom component config object.
 * @param data - Raw data to validate
 * @param name - Component name for error messages
 */
function parseCustomConfig(data: Record<string, unknown>, name: string): CustomComponentConfig {
  if (!isString(data['description'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.description" must be a string`);
  }
  if (!isString(data['targetPath'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.targetPath" must be a string`);
  }
  if (data['targetPath'].includes('..')) {
    throw new FurnaceError(
      `Furnace config: custom "${name}.targetPath" must not contain ".." (path traversal)`
    );
  }
  if (!isBoolean(data['register'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.register" must be a boolean`);
  }
  if (!isBoolean(data['localized'])) {
    throw new FurnaceError(`Furnace config: custom "${name}.localized" must be a boolean`);
  }
  if (data['composes'] !== undefined) {
    parseStringArray(data['composes'], `${name}.composes`);
  }

  return {
    description: data['description'],
    targetPath: data['targetPath'],
    register: data['register'],
    localized: data['localized'],
    ...(data['composes'] !== undefined
      ? { composes: parseStringArray(data['composes'], `${name}.composes`) }
      : {}),
  };
}

/**
 * Validates a raw config object and returns a typed FurnaceConfig.
 * @param data - Raw data to validate
 * @returns Validated FurnaceConfig
 * @throws Error if validation fails
 */
export function validateFurnaceConfig(data: unknown): FurnaceConfig {
  if (!isObject(data)) {
    throw new FurnaceError('Furnace config must be an object');
  }

  if (data['version'] !== 1) {
    throw new FurnaceError('Furnace config: "version" must be 1');
  }

  if (!isString(data['componentPrefix'])) {
    throw new FurnaceError('Furnace config: "componentPrefix" must be a string');
  }

  // Validate optional tokenPrefix
  if (data['tokenPrefix'] !== undefined && !isString(data['tokenPrefix'])) {
    throw new FurnaceError('Furnace config: "tokenPrefix" must be a string if provided');
  }

  // Validate optional tokenAllowlist
  if (data['tokenAllowlist'] !== undefined) {
    parseStringArray(data['tokenAllowlist'], 'tokenAllowlist');
  }

  const stock = parseStringArray(data['stock'], 'stock');

  // Validate overrides
  if (!isObject(data['overrides'])) {
    throw new FurnaceError('Furnace config: "overrides" must be an object');
  }

  const overrides: FurnaceConfig['overrides'] = {};
  for (const [name, value] of Object.entries(data['overrides'])) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new FurnaceError(
        `Furnace config: override name "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, no path separators)`
      );
    }
    if (!isObject(value)) {
      throw new FurnaceError(`Furnace config: override "${name}" must be an object`);
    }
    overrides[name] = parseOverrideConfig(value, name);
  }

  // Validate custom
  if (!isObject(data['custom'])) {
    throw new FurnaceError('Furnace config: "custom" must be an object');
  }

  const custom: FurnaceConfig['custom'] = {};
  for (const [name, value] of Object.entries(data['custom'])) {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      throw new FurnaceError(
        `Furnace config: custom name "${name}" must match /^[a-z][a-z0-9-]*$/ (lowercase, no path separators)`
      );
    }
    if (!isObject(value)) {
      throw new FurnaceError(`Furnace config: custom "${name}" must be an object`);
    }
    custom[name] = parseCustomConfig(value, name);
  }

  const config: FurnaceConfig = {
    version: 1,
    componentPrefix: data['componentPrefix'],
    stock,
    overrides,
    custom,
  };

  if (data['tokenPrefix'] !== undefined) {
    config.tokenPrefix = data['tokenPrefix'];
  }

  if (data['tokenAllowlist'] !== undefined) {
    config.tokenAllowlist = parseStringArray(data['tokenAllowlist'], 'tokenAllowlist');
  }

  return config;
}

interface FurnaceStateValidationResult {
  state: FurnaceState;
  issues: string[];
  recoveredFields: string[];
}

/**
 * Validates a parsed furnace state object and returns a typed FurnaceState.
 * @param data - Parsed JSON state data
 * @returns Validated FurnaceState
 */
export function validateFurnaceState(data: unknown): FurnaceState {
  const result = sanitizeFurnaceState(data);
  if (result.issues.length > 0) {
    throw new FurnaceError(`Invalid furnace state: ${result.issues.join('; ')}`);
  }
  return result.state;
}

function sanitizeFurnaceState(data: unknown): FurnaceStateValidationResult {
  if (!isObject(data)) {
    return {
      state: {},
      issues: ['the root value must be a JSON object'],
      recoveredFields: [],
    };
  }

  const state: FurnaceState = {};
  const issues: string[] = [];
  const recoveredFields: string[] = [];

  if (data['lastApply'] !== undefined) {
    if (!isString(data['lastApply'])) {
      issues.push('field "lastApply" must be a string');
    } else {
      state.lastApply = data['lastApply'];
      recoveredFields.push('lastApply');
    }
  }

  if (data['appliedChecksums'] !== undefined) {
    if (!isObject(data['appliedChecksums'])) {
      issues.push('field "appliedChecksums" must be an object of string checksum values');
    } else {
      const appliedChecksums: Record<string, string> = {};
      let hasInvalidChecksum = false;
      for (const [filePath, checksum] of Object.entries(data['appliedChecksums'])) {
        if (!isString(checksum)) {
          hasInvalidChecksum = true;
          issues.push(`appliedChecksums["${filePath}"] must be a string`);
          continue;
        }
        appliedChecksums[filePath] = checksum;
      }

      if (Object.keys(appliedChecksums).length > 0 || !hasInvalidChecksum) {
        state.appliedChecksums = appliedChecksums;
        recoveredFields.push('appliedChecksums');
      }
    }
  }

  return { state, issues, recoveredFields };
}

async function recoverInvalidFurnaceState(
  statePath: string,
  result: FurnaceStateValidationResult,
  alreadyLocked = false
): Promise<FurnaceState> {
  const recover = async (): Promise<FurnaceState> => {
    const quarantinedFile = await quarantineStateFile(statePath, 'invalid');
    if (result.recoveredFields.length > 0) {
      await writeJson(statePath, result.state);
    }

    const recoveryMessage =
      result.recoveredFields.length > 0
        ? ` Recovered valid field${result.recoveredFields.length === 1 ? '' : 's'}: ${result.recoveredFields.join(', ')}.`
        : ' No valid furnace state fields could be recovered; using defaults.';
    const quarantineMessage = quarantinedFile
      ? ` Quarantined the original file as ${quarantinedFile}.`
      : '';

    warn(
      `Furnace state file (.fireforge/furnace-state.json) was invalid: ${result.issues.join('; ')}.${recoveryMessage}${quarantineMessage}`
    );

    return result.state;
  };

  return alreadyLocked ? recover() : withStateFileLock(statePath, recover);
}

async function loadFurnaceStateFromPath(
  statePath: string,
  alreadyLocked = false
): Promise<FurnaceState> {
  if (!(await pathExists(statePath))) {
    return {};
  }

  try {
    const data = await readJson<unknown>(statePath);
    const result = sanitizeFurnaceState(data);
    if (result.issues.length === 0) {
      return result.state;
    }

    return await recoverInvalidFurnaceState(statePath, result, alreadyLocked);
  } catch (error: unknown) {
    return await recoverInvalidFurnaceState(
      statePath,
      {
        state: {},
        issues: [`the file could not be parsed: ${toError(error).message}`],
        recoveredFields: [],
      },
      alreadyLocked
    );
  }
}

/**
 * Loads and validates the furnace.json configuration.
 * @param root - Root directory of the project
 * @returns Validated FurnaceConfig
 * @throws Error if config doesn't exist or is invalid
 */
export async function loadFurnaceConfig(root: string): Promise<FurnaceConfig> {
  const paths = getFurnacePaths(root);

  if (!(await pathExists(paths.furnaceConfig))) {
    throw new FurnaceError(
      `Furnace configuration file not found: ${paths.furnaceConfig}\n\n` +
        'Run "fireforge furnace create" or "fireforge furnace override" to get started.'
    );
  }

  try {
    const data = await readJson<unknown>(paths.furnaceConfig);
    return validateFurnaceConfig(data);
  } catch (error: unknown) {
    if (error instanceof FurnaceError) {
      throw error;
    }

    throw new FurnaceError(
      `Invalid furnace.json at ${paths.furnaceConfig}: ${toError(error).message}`
    );
  }
}

/**
 * Writes a furnace configuration to furnace.json.
 * @param root - Root directory of the project
 * @param config - Configuration to write
 */
export async function writeFurnaceConfig(root: string, config: FurnaceConfig): Promise<void> {
  const paths = getFurnacePaths(root);
  await writeJson(paths.furnaceConfig, config);
}

/**
 * Creates a default furnace configuration.
 * @returns A valid empty FurnaceConfig
 */
export function createDefaultFurnaceConfig(): FurnaceConfig {
  return {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  };
}

/**
 * Loads furnace config if it exists, or creates and writes a default config.
 * @param root - Root directory of the project
 * @returns FurnaceConfig (existing or newly created)
 */
export async function ensureFurnaceConfig(root: string): Promise<FurnaceConfig> {
  if (await furnaceConfigExists(root)) {
    return loadFurnaceConfig(root);
  }

  const config = createDefaultFurnaceConfig();
  await writeFurnaceConfig(root, config);
  return config;
}

/**
 * Loads the furnace state, or returns defaults if it doesn't exist.
 * @param root - Root directory of the project
 * @returns Furnace state
 */
export async function loadFurnaceState(root: string): Promise<FurnaceState> {
  const paths = getFurnacePaths(root);
  return loadFurnaceStateFromPath(paths.furnaceState);
}

/**
 * Saves the furnace state.
 * @param root - Root directory of the project
 * @param state - State to save
 */
export async function saveFurnaceState(root: string, state: FurnaceState): Promise<void> {
  const paths = getFurnacePaths(root);
  const validatedState = validateFurnaceState(state);
  await withStateFileLock(paths.furnaceState, async () => {
    await writeJson(paths.furnaceState, validatedState);
  });
}

/**
 * Updates furnace state fields transactionally under the state file lock.
 * @param root - Root directory of the project
 * @param updates - Fields to update, or a transactional updater function
 */
export async function updateFurnaceState(
  root: string,
  updates: Partial<FurnaceState> | ((current: FurnaceState) => FurnaceState)
): Promise<void> {
  const paths = getFurnacePaths(root);
  await withStateFileLock(paths.furnaceState, async () => {
    const current = await loadFurnaceStateFromPath(paths.furnaceState, true);
    const nextState = typeof updates === 'function' ? updates(current) : { ...current, ...updates };
    await writeJson(paths.furnaceState, validateFurnaceState(nextState));
  });
}
