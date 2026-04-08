// SPDX-License-Identifier: EUPL-1.2
/**
 * Project path derivation from a root directory.
 */

import { join } from 'node:path';

import type { ProjectPaths } from '../types/config.js';

/** Name of the configuration file */
export const CONFIG_FILENAME = 'fireforge.json';

/** Name of the fireforge data directory */
export const FIREFORGE_DIR = '.fireforge';

/** Name of the state file */
export const STATE_FILENAME = 'state.json';

/** Name of the engine directory */
export const ENGINE_DIR = 'engine';

/** Name of the patches directory */
export const PATCHES_DIR = 'patches';

/** Name of the configs directory */
export const CONFIGS_DIR = 'configs';

/** Name of the source directory */
export const SRC_DIR = 'src';

/** Supported top-level fireforge.json keys backed by the current schema. */
export const SUPPORTED_CONFIG_ROOT_KEYS = [
  'name',
  'vendor',
  'appId',
  'binaryName',
  'firefox',
  'build',
  'license',
  'wire',
] as const;

/** Supported config paths that can be read or set without --force. */
export const SUPPORTED_CONFIG_PATHS = [
  'name',
  'vendor',
  'appId',
  'binaryName',
  'license',
  'firefox',
  'firefox.version',
  'firefox.product',
  'build',
  'build.jobs',
  'wire',
  'wire.subscriptDir',
] as const;

/**
 * Gets all project paths based on a root directory.
 * @param root - Root directory of the project
 * @returns All project paths
 */
export function getProjectPaths(root: string): ProjectPaths {
  const fireforgeDir = join(root, FIREFORGE_DIR);
  return {
    root,
    config: join(root, CONFIG_FILENAME),
    fireforgeDir,
    state: join(fireforgeDir, STATE_FILENAME),
    engine: join(root, ENGINE_DIR),
    patches: join(root, PATCHES_DIR),
    configs: join(root, CONFIGS_DIR),
    src: join(root, SRC_DIR),
    componentsDir: join(root, 'components'),
  };
}
