// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { FurnaceError } from '../errors/furnace.js';
import type {
  FurnaceConfig,
  FurnacePendingRepair,
  FurnacePendingRepairOperation,
  FurnaceState,
} from '../types/furnace.js';
import { FURNACE_PENDING_REPAIR_OPERATIONS } from '../types/furnace.js';
import type { JsonObject } from '../types/json.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { isObject, isString } from '../utils/validation.js';
import { FIREFORGE_DIR } from './config.js';
import { parseStringArray } from './furnace-config-array-utils.js';
import { parseCustomConfig } from './furnace-config-custom.js';
import { orderFurnaceConfigForWrite } from './furnace-config-order.js';
import { validateRuntimeVariables, validateTokenHostDocuments } from './furnace-config-tokens.js';
import {
  applyOptionalFurnaceFields,
  parseNamedComponentMap,
  parseOverrideConfig,
  parseStockList,
} from './furnace-config-validate.js';
import { resolveFtlDir } from './furnace-constants.js';
import { detectComposesCycles, validateComposesReferences } from './furnace-graph-utils.js';
import { quarantineStateFile, withStateFileLock } from './state-file.js';

export { detectComposesCycles };

/** Name of the furnace configuration file */
const FURNACE_CONFIG_FILENAME = 'furnace.json';

/** Name of the furnace state file */
const FURNACE_STATE_FILENAME = 'furnace-state.json';

/** Name of the components directory */
const COMPONENTS_DIR = 'components';

/** Name of the overrides subdirectory */
const OVERRIDES_DIR = 'overrides';

/** Name of the custom subdirectory */
const CUSTOM_DIR = 'custom';

/** Directory name for shared CSS fragments within components/ */
export const SHARED_FRAGMENTS_DIR = 'shared';

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
  /** Path to components/shared directory (CSS fragments) */
  sharedDir: string;
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
    sharedDir: join(componentsDir, SHARED_FRAGMENTS_DIR),
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

/** The current (and only) config schema version. */
const CURRENT_CONFIG_VERSION = 1;

/**
 * Migrates a furnace config from an older schema version to the current one.
 * Returns the data unchanged if it is already at the current version.
 *
 * When a future version 2 is introduced, add a `case 1:` that transforms
 * v1 data into v2 shape and falls through to validation. The pattern is:
 *
 * ```
 * case 1:
 *   data = migrateV1ToV2(data);
 *   // fallthrough
 * case 2:
 *   break;
 * ```
 */
function migrateFurnaceConfig(data: JsonObject): JsonObject {
  const version = data['version'];

  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new FurnaceError(
      `Furnace config: "version" must be a positive integer (got ${JSON.stringify(version)}). ` +
        `Current schema version is ${CURRENT_CONFIG_VERSION}.`
    );
  }

  if (version > CURRENT_CONFIG_VERSION) {
    throw new FurnaceError(
      `Furnace config: version ${version} is newer than what this version of FireForge supports (${CURRENT_CONFIG_VERSION}). ` +
        'Upgrade FireForge to read this config.'
    );
  }

  // Today only version 1 exists, so no migration is needed. When future
  // versions are added, migration steps will be chained here.
  return data;
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

  // Furnace config documents arrive from JSON.parse (loadFurnaceConfig /
  // writeFurnaceConfig round-trips), which can only produce JSON values,
  // so the object check above is the only invariant left to establish.
  // Run migration before validation so older configs are transparently upgraded.
  const migrated = migrateFurnaceConfig(data as JsonObject);

  if (migrated['version'] !== CURRENT_CONFIG_VERSION) {
    throw new FurnaceError(
      `Furnace config: "version" must be ${CURRENT_CONFIG_VERSION} after migration`
    );
  }

  if (!isString(migrated['componentPrefix'])) {
    throw new FurnaceError('Furnace config: "componentPrefix" must be a string');
  }

  // Validate optional tokenPrefix
  if (migrated['tokenPrefix'] !== undefined && !isString(migrated['tokenPrefix'])) {
    throw new FurnaceError('Furnace config: "tokenPrefix" must be a string if provided');
  }

  // Validate optional tokenAllowlist
  if (migrated['tokenAllowlist'] !== undefined) {
    parseStringArray(migrated['tokenAllowlist'], 'tokenAllowlist');
  }

  // Validate optional runtimeVariables — CSS runtime state channels
  // (e.g. `--cam-x`) that are exempt from `token-prefix-violation`.
  validateRuntimeVariables(migrated['runtimeVariables']);

  // Validate optional tokenHostDocuments — list of chrome XHTMLs that the
  // `missing-token-link` validator scans for the tokens CSS link.
  validateTokenHostDocuments(migrated['tokenHostDocuments']);

  const stock = parseStockList(migrated['stock']);

  const overrides = parseNamedComponentMap(
    migrated['overrides'],
    'override',
    'overrides',
    parseOverrideConfig
  );
  const custom = parseNamedComponentMap(migrated['custom'], 'custom', 'custom', parseCustomConfig);

  // Detect circular composes references among custom components.
  detectComposesCycles(custom);

  // Validate that every composes reference points to a known component.
  validateComposesReferences(stock, overrides, custom);

  // Warn when two custom components share a targetPath. Nothing technically
  // prevents co-location, but per-component removal and orphan detection
  // both reason about "files this component deployed into its directory" —
  // shared directories make those judgements ambiguous, and can lead to
  // `furnace remove` of one component deleting the other's deployed files.
  const targetPathOwners = new Map<string, string[]>();
  for (const [name, custom_] of Object.entries(custom)) {
    const owners = targetPathOwners.get(custom_.targetPath) ?? [];
    owners.push(name);
    targetPathOwners.set(custom_.targetPath, owners);
  }
  for (const [targetPath, owners] of targetPathOwners) {
    if (owners.length > 1) {
      warn(
        `furnace.json: custom components ${owners.join(', ')} share targetPath "${targetPath}". ` +
          'Give each component its own directory — shared directories make per-component ' +
          'removal and drift detection ambiguous.'
      );
    }
  }

  const config: FurnaceConfig = {
    version: CURRENT_CONFIG_VERSION,
    componentPrefix: migrated['componentPrefix'],
    stock,
    overrides,
    custom,
  };

  applyOptionalFurnaceFields(migrated, config);

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
function validateFurnaceState(data: unknown): FurnaceState {
  const result = sanitizeFurnaceState(data);
  if (result.issues.length > 0) {
    throw new FurnaceError(`Invalid furnace state: ${result.issues.join('; ')}`);
  }
  return result.state;
}

// Single source of truth: the list the union is derived from. The copy
// this replaced was annotated, not linked — it caught a member REMOVED
// from the union but never one ADDED to it, and listed them in a
// different order.
const PENDING_REPAIR_OPERATIONS = FURNACE_PENDING_REPAIR_OPERATIONS;

function parsePendingRepair(data: unknown): FurnacePendingRepair | { error: string } {
  if (!isObject(data)) {
    return { error: 'field "pendingRepair" must be an object' };
  }
  if (
    !isString(data['operation']) ||
    !PENDING_REPAIR_OPERATIONS.includes(data['operation'] as FurnacePendingRepairOperation)
  ) {
    return {
      error: `pendingRepair.operation must be one of: ${PENDING_REPAIR_OPERATIONS.join(', ')}`,
    };
  }
  if (!isString(data['timestamp'])) {
    return { error: 'pendingRepair.timestamp must be a string' };
  }
  if (!isString(data['reason'])) {
    return { error: 'pendingRepair.reason must be a string' };
  }
  return {
    operation: data['operation'] as FurnacePendingRepairOperation,
    timestamp: data['timestamp'],
    reason: data['reason'],
  };
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

  if (data['engineChecksums'] !== undefined) {
    if (!isObject(data['engineChecksums'])) {
      issues.push('field "engineChecksums" must be an object of string checksum values');
    } else {
      const engineChecksums: Record<string, string> = {};
      for (const [filePath, checksum] of Object.entries(data['engineChecksums'])) {
        if (isString(checksum)) {
          engineChecksums[filePath] = checksum;
        }
      }
      if (Object.keys(engineChecksums).length > 0) {
        state.engineChecksums = engineChecksums;
        recoveredFields.push('engineChecksums');
      }
    }
  }

  if (data['pendingRepair'] !== undefined) {
    const parsed = parsePendingRepair(data['pendingRepair']);
    if ('error' in parsed) {
      issues.push(parsed.error);
    } else {
      state.pendingRepair = parsed;
      recoveredFields.push('pendingRepair');
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
 * Clears applied furnace state while preserving `pendingRepair`.
 *
 * Used whenever the engine baseline is replaced or reset (download --force,
 * reset, rebase, rebase --abort): every applied checksum describes content
 * that no longer exists, but pendingRepair tracks authoring-side rollback
 * issues in the component WORKSPACE and must survive an engine refresh.
 * No-ops when the state file does not exist.
 */
export async function clearAppliedFurnaceState(root: string): Promise<void> {
  const paths = getFurnacePaths(root);
  if (!(await pathExists(paths.furnaceState))) return;
  await updateFurnaceState(root, (current) => ({
    ...(current.pendingRepair ? { pendingRepair: current.pendingRepair } : {}),
  }));
}

/**
 * Writes a furnace configuration to furnace.json.
 * @param root - Root directory of the project
 * @param config - Configuration to write
 */
export async function writeFurnaceConfig(root: string, config: FurnaceConfig): Promise<void> {
  const paths = getFurnacePaths(root);
  let existing: JsonObject | undefined;
  if (await pathExists(paths.furnaceConfig)) {
    try {
      const raw = await readJson<unknown>(paths.furnaceConfig);
      // JSON.parse output is JSON data by construction, so the object
      // check is the only invariant left for the JsonObject contract.
      if (isObject(raw)) existing = raw as JsonObject;
    } catch {
      // A missing or corrupt furnace.json means there is no prior document to
      // preserve key order from; the writer falls back to canonical ordering.
      existing = undefined;
    }
  }
  await writeJson(paths.furnaceConfig, orderFurnaceConfigForWrite(existing, config));
}

/**
 * Stamps every override's `baseVersion` to the supplied version. Used by
 * `fireforge rebase` after a successful patch re-export, so an ESR bump does
 * not leave Furnace overrides in a doctor-failing drift state: `rebase`
 * stamps patch `sourceEsrVersion` via `stampPatchVersions`, and without the
 * matching override stamp `doctor` fails Furnace component validation on
 * every override.
 *
 * The stamp is deliberately unconditional — `fireforge furnace validate` is
 * the right tool for "does this override still apply", and rebase has
 * already attested that the patch layer re-validated against the new ESR.
 *
 * @param root - Root directory of the project
 * @param version - Firefox version string to stamp onto every override
 * @returns Number of overrides whose `baseVersion` was updated (either
 *   because it was missing or because it differed from `version`).
 */
export async function stampFurnaceOverrideBaseVersions(
  root: string,
  version: string
): Promise<number> {
  if (!(await furnaceConfigExists(root))) return 0;
  const config = await loadFurnaceConfig(root);
  let changed = 0;
  for (const override of Object.values(config.overrides)) {
    if (override.baseVersion !== version) {
      override.baseVersion = version;
      changed++;
    }
  }
  if (changed > 0) {
    await writeFurnaceConfig(root, config);
  }
  return changed;
}

/**
 * Creates a default furnace configuration.
 *
 * When a `binaryName` is provided, the default config carries a
 * `tokenPrefix` derived as `--<binaryName>-`. Without it, `fireforge token
 * coverage` on a fresh project reports `0 tokens` and labels every
 * custom-property reference as `unknown`, because the scan has no prefix to
 * key off. Deriving the prefix from the binary name matches the convention
 * the scaffolded tokens CSS already uses for its `--<binaryName>-*`
 * declarations.
 *
 * `validateFurnaceConfig` treats `tokenPrefix` as optional, so callers on
 * the no-arg call shape still get a valid config without a prefix; the CLI
 * init path always has a `binaryName` from `fireforge.json` and always sets
 * one.
 *
 * @param options - Optional init context; pass `{ binaryName }` to derive
 *   the token prefix.
 * @returns A valid FurnaceConfig
 */
export function createDefaultFurnaceConfig(options: { binaryName?: string } = {}): FurnaceConfig {
  const config: FurnaceConfig = {
    version: 1,
    componentPrefix: 'moz-',
    stock: [],
    overrides: {},
    custom: {},
  };
  if (options.binaryName && options.binaryName.length > 0) {
    config.tokenPrefix = `--${options.binaryName}-`;
  }
  return config;
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

/**
 * Engine-relative path of the directory `furnace preview` writes its
 * generated Storybook story files into. Treated as Furnace-managed so
 * `status` does not flag them as unmanaged and `lint` does not fail on their
 * (intentionally bare) license headers — they are tool output, not files an
 * operator commits or hand-edits.
 */
const FURNACE_STORYBOOK_STORIES_PREFIX = 'browser/components/storybook/stories/furnace/';

/**
 * Collects engine-relative path prefixes that are managed by the Furnace
 * component system (overrides, custom components, and their Fluent l10n
 * files). Used by `status` and `export-all` to classify engine changes
 * as Furnace-managed rather than unmanaged drift.
 *
 * Returns an empty set when no furnace config exists (opt-in subsystem).
 * Prefixes always end with `/` so callers can use `startsWith()`.
 */
export async function collectFurnaceManagedPrefixes(root: string): Promise<Set<string>> {
  if (!(await furnaceConfigExists(root))) return new Set();
  const config = await loadFurnaceConfig(root);
  const ftlDir = resolveFtlDir(config.ftlBasePath);
  const prefixes = new Set<string>();

  for (const [, overrideCfg] of Object.entries(config.overrides)) {
    const base = overrideCfg.basePath.endsWith('/')
      ? overrideCfg.basePath
      : overrideCfg.basePath + '/';
    prefixes.add(base);
  }

  for (const [, customCfg] of Object.entries(config.custom)) {
    const target = customCfg.targetPath.endsWith('/')
      ? customCfg.targetPath
      : customCfg.targetPath + '/';
    prefixes.add(target);
    if (customCfg.localized) {
      prefixes.add(ftlDir.endsWith('/') ? ftlDir : ftlDir + '/');
    }
  }

  // Always include the preview-generated stories prefix when furnace is
  // initialised. The directory may not exist yet (no preview ever ran),
  // but classifying it as furnace-managed is safe even when empty —
  // status simply has nothing to bucket.
  prefixes.add(FURNACE_STORYBOOK_STORIES_PREFIX);

  return prefixes;
}
