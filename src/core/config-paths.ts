// SPDX-License-Identifier: EUPL-1.2
/**
 * Project path derivation from a root directory.
 */

import { join } from 'node:path';

import type { ProjectPaths } from '../types/config.js';

/** Name of the configuration file */
const CONFIG_FILENAME = 'fireforge.json';

/** Name of the fireforge data directory */
export const FIREFORGE_DIR = '.fireforge';

/** Name of the state file */
const STATE_FILENAME = 'state.json';

/** Name of the engine directory */
const ENGINE_DIR = 'engine';

/** Name of the patches directory */
const PATCHES_DIR = 'patches';

/** Name of the configs directory */
const CONFIGS_DIR = 'configs';

/** Name of the source directory */
const SRC_DIR = 'src';

/** Supported top-level fireforge.json keys backed by the current schema. */
export const SUPPORTED_CONFIG_ROOT_KEYS = [
  'name',
  'vendor',
  'appId',
  'binaryName',
  'firefox',
  'sources',
  'build',
  'slots',
  'buildAudit',
  'test',
  'history',
  'externalToolchains',
  'license',
  'wire',
  'patchLint',
  'patchPolicy',
  'buildAudit',
  'buildAudit.unpackaged',
  'exportQueue',
  'typecheck',
  'markerComment',
  'check',
  'proof',
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
  'firefox.sha256',
  'firefox.candidate',
  'firefox.allowUnverifiedDownload',
  'sources',
  'sources.schemaVersion',
  'sources.mode',
  'sources.root',
  'sources.metadataRoot',
  'sources.pristineCommit',
  'build',
  'build.jobs',
  'build.release',
  'slots',
  'slots.dependencyCaches',
  'test',
  'test.canaryPath',
  'test.canaryTimeoutSeconds',
  'test.reapOrphans',
  'test.mochitestPorts',
  'test.lockMode',
  'test.furnaceApply',
  'history',
  'history.path',
  'externalToolchains',
  'wire',
  'wire.subscriptDir',
  'patchLint',
  'patchLint.checkJs',
  'patchLint.checkJsStrict',
  'patchLint.checkJsCompilerOptions',
  'patchLint.checkJsExtraShim',
  'patchLint.checkJsTestFiles',
  'patchLint.checkJsTestShim',
  'patchLint.rawColorAllowlist',
  'patchLint.prettier',
  'patchLint.undefinedIdentifiers',
  'patchLint.litTypes',
  'patchLint.tokenScales',
  'patchLint.fileSizeThresholds',
  'patchLint.patchSizeThresholds',
  'patchLint.patchSizeRegistrationFiles',
  'patchLint.jsdocClassMethods',
  'patchLint.testAssertionFloor',
  'patchLint.chromeScriptJsDoc',
  'patchLint.forwardRegistration',
  'patchLint.fileSizeMetric',
  'patchLint.patchSizeMetric',
  'patchPolicy',
  'buildAudit',
  'buildAudit.unpackaged',
  'exportQueue',
  'exportQueue.groups',
  'exportQueue.maxGroupBytes',
  'typecheck',
  'typecheck.projects',
  'typecheck.extraShim',
  'typecheck.projectOverrides',
  'typecheck.undefinedIdentifiers',
  'typecheck.litTypes',
  'markerComment',
  'check',
  'check.skip',
  'check.status',
  'check.maxWarnings',
  'check.extraSteps',
  'check.timeout',
  'check.timeouts',
  'check.failOnSkipped',
  'check.lintReport',
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
