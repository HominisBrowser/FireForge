// SPDX-License-Identifier: EUPL-1.2
/**
 * Project configuration — barrel module.
 *
 * Re-exports from focused sub-modules:
 *   config-paths.ts    — constants and project path derivation
 *   config-validate.ts — fireforge.json schema validation
 *   config-mutate.ts   — immutable config mutation
 *   config-state.ts    — state file management
 */

import { ConfigError, ConfigNotFoundError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { getProjectPaths } from './config-paths.js';
import { validateConfig } from './config-validate.js';

// ---- re-exports ----

export { mutateConfig } from './config-mutate.js';
export {
  CONFIG_FILENAME,
  CONFIGS_DIR,
  ENGINE_DIR,
  FIREFORGE_DIR,
  getProjectPaths,
  PATCHES_DIR,
  SRC_DIR,
  STATE_FILENAME,
  SUPPORTED_CONFIG_PATHS,
  SUPPORTED_CONFIG_ROOT_KEYS,
} from './config-paths.js';
export { loadState, saveState, updateState, validateFireForgeState } from './config-state.js';
export { validateConfig } from './config-validate.js';

// ---- config I/O (stays here because it bridges paths + validation) ----

/**
 * Checks if a fireforge.json exists in the given directory.
 * @param root - Root directory to check
 * @returns True if fireforge.json exists
 */
export async function configExists(root: string): Promise<boolean> {
  const paths = getProjectPaths(root);
  return pathExists(paths.config);
}

/**
 * Loads and validates the fireforge.json configuration.
 * @param root - Root directory of the project
 * @returns Validated FireForgeConfig
 * @throws Error if config doesn't exist or is invalid
 */
export async function loadConfig(root: string): Promise<FireForgeConfig> {
  const paths = getProjectPaths(root);

  if (!(await pathExists(paths.config))) {
    throw new ConfigNotFoundError(paths.config);
  }

  try {
    const data = await readJson<unknown>(paths.config);
    return validateConfig(data);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(`Invalid fireforge.json at ${paths.config}: ${toError(error).message}`);
  }
}

/**
 * Writes a configuration to fireforge.json.
 * @param root - Root directory of the project
 * @param config - Configuration to write
 */
export async function writeConfig(root: string, config: FireForgeConfig): Promise<void> {
  await writeConfigDocument(root, config);
}

/**
 * Writes a raw config document to fireforge.json.
 * This is used by CLI `config --force`, where callers may intentionally write
 * keys or value shapes outside the validated FireForgeConfig schema.
 */
export async function writeConfigDocument(
  root: string,
  config: FireForgeConfig | Record<string, unknown>
): Promise<void> {
  const paths = getProjectPaths(root);
  await writeJson(paths.config, config);
}
