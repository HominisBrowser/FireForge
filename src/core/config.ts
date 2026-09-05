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

import { basename } from 'node:path';

import { ConfigError, ConfigNotFoundError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import type { JsonObject } from '../types/json.js';
import { toError } from '../utils/errors.js';
import * as fsUtils from '../utils/fs.js';
import { isObject } from '../utils/validation.js';
import { getProjectPaths } from './config-paths.js';
import { validateConfig } from './config-validate.js';
import { createSiblingLockPath, withFileLock } from './file-lock.js';

// ---- re-exports ----

export { mutateConfig } from './config-mutate.js';
export {
  FIREFORGE_DIR,
  getProjectPaths,
  SUPPORTED_CONFIG_PATHS,
  SUPPORTED_CONFIG_ROOT_KEYS,
} from './config-paths.js';
export { loadState, updateState } from './config-state.js';
export { validateConfig } from './config-validate.js';

// ---- config I/O (stays here because it bridges paths + validation) ----

/**
 * Checks if a fireforge.json exists in the given directory.
 * @param root - Root directory to check
 * @returns True if fireforge.json exists
 */
export async function configExists(root: string): Promise<boolean> {
  const paths = getProjectPaths(root);
  // Strict probe: a permission error on `fireforge.json` must propagate
  // rather than read as "no config here", which plain `pathExists` reports.
  return fsUtils.pathExistsStrict(paths.config);
}

/**
 * Loads and validates the fireforge.json configuration.
 * @param root - Root directory of the project
 * @returns Validated FireForgeConfig
 * @throws Error if config doesn't exist or is invalid
 */
export async function loadConfig(root: string): Promise<FireForgeConfig> {
  const paths = getProjectPaths(root);

  // Strict probe: a permission error on `fireforge.json` must propagate
  // rather than read as "no config here", which plain `pathExists` reports.
  if (!(await fsUtils.pathExistsStrict(paths.config))) {
    throw new ConfigNotFoundError(paths.config);
  }

  try {
    const data = await fsUtils.readJson<unknown>(paths.config);
    return validateConfig(data);
  } catch (error: unknown) {
    if (error instanceof ConfigError) {
      throw error;
    }

    throw new ConfigError(`Invalid fireforge.json at ${paths.config}: ${toError(error).message}`);
  }
}

/**
 * Reads the raw `fireforge.json` document without running it through
 * {@link validateConfig}. Returns every persisted key — including keys
 * written via `fireforge config <key> --force` that `validateConfig`
 * would strip from the typed result.
 *
 * Callers that need the validated, typed shape must still use
 * {@link loadConfig}; this helper exists specifically for the `config`
 * read path so `fireforge config <key>` can surface keys the write path
 * accepted under `--force`.
 *
 * @param root - Root directory of the project
 * @returns Raw config object as persisted on disk
 * @throws ConfigNotFoundError when fireforge.json is missing
 * @throws ConfigError when the file is not valid JSON
 */
export async function loadRawConfigDocument(root: string): Promise<JsonObject> {
  const paths = getProjectPaths(root);

  // Strict probe: a permission error on `fireforge.json` must propagate
  // rather than read as "no config here", which plain `pathExists` reports.
  if (!(await fsUtils.pathExistsStrict(paths.config))) {
    throw new ConfigNotFoundError(paths.config);
  }

  try {
    const data = await fsUtils.readJson<unknown>(paths.config);
    if (!isObject(data)) {
      throw new ConfigError(`Invalid fireforge.json at ${paths.config}: expected an object`);
    }
    // `data` came out of JSON.parse, which can only ever produce JSON
    // values, so with the object check above the JsonObject contract holds.
    return data as JsonObject;
  } catch (error: unknown) {
    if (error instanceof ConfigError || error instanceof ConfigNotFoundError) {
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
 *
 * Individual writes are atomic via {@link writeJson} (temp file + rename),
 * but atomicity alone does not prevent lost updates across concurrent
 * writers: each writer reads an old copy, mutates its own in-memory view,
 * and writes it back, so the second writer's rename clobbers the first
 * writer's changes. Callers that do read → mutate → write must hold
 * {@link withConfigFileLock} for the full round-trip to serialise
 * against other writers.
 */
export async function writeConfigDocument(
  root: string,
  config: FireForgeConfig | JsonObject
): Promise<void> {
  const paths = getProjectPaths(root);
  await fsUtils.writeJson(paths.config, config);
}

/**
 * Runs an operation while holding a sidecar lock on `fireforge.json`.
 *
 * Two concurrent `fireforge config <key> <value>` invocations each run
 * load → mutate → writeJson against the same document; without this lock the
 * second rename lands after the first and silently drops the first writer's
 * key, with both commands exiting 0.
 *
 * Reads (`loadConfig`, `loadRawConfigDocument`) stay lock-free: writers
 * always use `writeJson`'s atomic temp-file + rename, so a reader observes
 * either the pre- or post-write document but never a torn file. The lock
 * only serialises writers against other writers.
 *
 * The lock is a sidecar directory `${config}.fireforge-config.lock`, and
 * `withFileLock` handles stale-lock recovery (PID-alive probe, age-based
 * fallback), so a crashed writer does not permanently block future writes.
 *
 * @param root - Root directory of the project
 * @param operation - Async function to run while holding the lock
 * @returns Whatever the operation returns
 */
export async function withConfigFileLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const paths = getProjectPaths(root);
  return withFileLock(createSiblingLockPath(paths.config, '.fireforge-config.lock'), operation, {
    onTimeoutMessage:
      `Timed out waiting to update ${basename(paths.config)}. ` +
      'If no other fireforge process is running, remove the stale lock directory and retry.',
    onStaleLockMessage: (ageMs) =>
      `Removing stale FireForge config lock for ${basename(paths.config)} ` +
      `(age: ${Math.round(ageMs / 1000)}s). A previous fireforge process may have crashed.`,
  });
}
