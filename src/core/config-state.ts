// SPDX-License-Identifier: EUPL-1.2
/**
 * Project state file management (.fireforge/state.json).
 */

import { ConfigError } from '../errors/config.js';
import type { FireForgeState } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { warn } from '../utils/logger.js';
import { isObject, isString } from '../utils/validation.js';
import { getProjectPaths } from './config-paths.js';
import { quarantineStateFile, withStateFileLock } from './state-file.js';

interface StateValidationResult {
  state: FireForgeState;
  issues: string[];
  recoveredFields: string[];
}

function sanitizeProjectState(data: unknown): StateValidationResult {
  if (!isObject(data)) {
    return {
      state: {},
      issues: ['the root value must be a JSON object'],
      recoveredFields: [],
    };
  }

  const state: FireForgeState = {};
  const issues: string[] = [];
  const recoveredFields: string[] = [];
  const stringFields = [
    'brand',
    'buildMode',
    'lastBuild',
    'downloadedVersion',
    'baseCommit',
  ] as const;

  for (const key of stringFields) {
    const value = data[key];
    if (value === undefined) {
      continue;
    }

    if (!isString(value)) {
      issues.push(`field "${key}" must be a string`);
      continue;
    }

    if (key === 'buildMode' && !['dev', 'debug', 'release'].includes(value)) {
      issues.push('field "buildMode" must be one of: dev, debug, release');
      continue;
    }

    if (key === 'buildMode') {
      state.buildMode = value as NonNullable<FireForgeState['buildMode']>;
    } else {
      state[key] = value;
    }
    recoveredFields.push(key);
  }

  const pendingResolution = data['pendingResolution'];
  if (pendingResolution !== undefined) {
    if (
      isObject(pendingResolution) &&
      isString(pendingResolution['patchFilename']) &&
      isString(pendingResolution['originalError'])
    ) {
      state.pendingResolution = {
        patchFilename: pendingResolution['patchFilename'],
        originalError: pendingResolution['originalError'],
      };
      recoveredFields.push('pendingResolution');
    } else {
      issues.push(
        'field "pendingResolution" must be an object with string fields "patchFilename" and "originalError"'
      );
    }
  }

  return { state, issues, recoveredFields };
}

/**
 * Validates a parsed project state object and returns a typed FireForgeState.
 * @param data - Parsed JSON state data
 * @returns Validated FireForgeState
 */
export function validateFireForgeState(data: unknown): FireForgeState {
  const result = sanitizeProjectState(data);
  if (result.issues.length > 0) {
    throw new ConfigError(`Invalid FireForge state: ${result.issues.join('; ')}`);
  }
  return result.state;
}

async function recoverInvalidProjectState(
  statePath: string,
  result: StateValidationResult,
  alreadyLocked = false
): Promise<FireForgeState> {
  const recover = async (): Promise<FireForgeState> => {
    const quarantinedFile = await quarantineStateFile(statePath);
    if (result.recoveredFields.length > 0) {
      await writeJson(statePath, result.state);
    }

    const quarantineMessage = quarantinedFile
      ? ` Quarantined the original file as ${quarantinedFile}.`
      : '';
    const recoveryMessage =
      result.recoveredFields.length > 0
        ? ` Recovered valid field${result.recoveredFields.length === 1 ? '' : 's'}: ${result.recoveredFields.join(', ')}.`
        : ' No valid state fields could be recovered; using defaults.';

    warn(
      `State file (.fireforge/state.json) was invalid: ${result.issues.join('; ')}.${recoveryMessage}${quarantineMessage} ` +
        'Run "fireforge doctor" to check project health.'
    );

    return result.state;
  };

  return alreadyLocked ? recover() : withStateFileLock(statePath, recover);
}

async function loadStateFromPath(
  statePath: string,
  alreadyLocked = false
): Promise<FireForgeState> {
  if (!(await pathExists(statePath))) {
    return {};
  }

  try {
    const data = await readJson<unknown>(statePath);
    const result = sanitizeProjectState(data);
    if (result.issues.length === 0) {
      return result.state;
    }

    return await recoverInvalidProjectState(statePath, result, alreadyLocked);
  } catch (error: unknown) {
    return await recoverInvalidProjectState(
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
 * Loads the fireforge state, or returns defaults if it doesn't exist.
 * @param root - Root directory of the project
 * @returns FireForge state
 */
export async function loadState(root: string): Promise<FireForgeState> {
  const paths = getProjectPaths(root);
  return loadStateFromPath(paths.state);
}

/**
 * Saves the fireforge state.
 * @param root - Root directory of the project
 * @param state - State to save
 */
export async function saveState(root: string, state: FireForgeState): Promise<void> {
  const paths = getProjectPaths(root);
  const validatedState = validateFireForgeState(state);
  await withStateFileLock(paths.state, async () => {
    await writeJson(paths.state, validatedState);
  });
}

/**
 * Updates specific fields in the fireforge state.
 * @param root - Root directory of the project
 * @param updates - Fields to update, or a transactional updater function
 */
export async function updateState(
  root: string,
  updates: Partial<FireForgeState> | ((current: FireForgeState) => FireForgeState)
): Promise<void> {
  const paths = getProjectPaths(root);
  await withStateFileLock(paths.state, async () => {
    const current = await loadStateFromPath(paths.state, true);
    const nextState = typeof updates === 'function' ? updates(current) : { ...current, ...updates };
    await writeJson(paths.state, validateFireForgeState(nextState));
  });
}
