// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import {
  configExists,
  loadConfig,
  mutateConfig,
  SUPPORTED_CONFIG_PATHS,
  SUPPORTED_CONFIG_ROOT_KEYS,
  writeConfig,
  writeConfigDocument,
} from '../core/config.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { toError } from '../utils/errors.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Gets a nested value from an object using dot notation.
 * @param obj - Object to traverse
 * @param path - Dot-separated path (e.g., "firefox.version")
 * @returns The value at the path, or undefined if not found
 */
function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/** Config keys that must always be stored as strings. */
const STRING_TYPED_KEYS = new Set([
  'name',
  'vendor',
  'appId',
  'binaryName',
  'firefox.version',
  'firefox.product',
  'license',
  'wire.subscriptDir',
]);

/**
 * Parses a string value into the appropriate type.
 * Keys listed in STRING_TYPED_KEYS are always stored as strings to prevent
 * accidental type coercion (e.g. `fireforge config firefox.version 128` would
 * otherwise become the number 128 instead of the string "128").
 */
function parseValue(value: string, key?: string): unknown {
  // For known string-typed keys, always return as string
  if (key && STRING_TYPED_KEYS.has(key)) {
    return value;
  }

  // Try to parse as JSON first (handles numbers, booleans, arrays, objects).
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'string') {
      warn(`Value "${value}" was interpreted as ${typeof parsed}. Use '"${value}"' for a string.`);
    }
    return parsed;
  } catch (error: unknown) {
    void error;
    // Fall back to string
    return value;
  }
}

/**
 * Formats a value for display.
 */
function formatValue(value: unknown): string {
  if (value === undefined) {
    return '(not set)';
  }
  if (value === null || typeof value === 'object' || typeof value === 'function') {
    return JSON.stringify(value, null, 2);
  }
  return String(value as string | number | boolean | bigint | symbol);
}

/**
 * Runs the config command to get or set configuration values.
 * @param projectRoot - Root directory of the project
 * @param key - Configuration key (dot notation)
 * @param value - Optional value to set
 */
export async function configCommand(
  projectRoot: string,
  key: string,
  value?: string,
  options: { force?: boolean } = {}
): Promise<void> {
  intro('FireForge Config');

  // Check if config exists
  if (!(await configExists(projectRoot))) {
    throw new GeneralError('No fireforge.json found. Run "fireforge setup" to create a project.');
  }

  const config = await loadConfig(projectRoot);

  if (value === undefined) {
    // Get mode
    const currentValue = getNestedValue(config, key);

    if (currentValue === undefined) {
      throw new InvalidArgumentError(`Unknown config key: ${key}`);
    } else {
      info(`${key} = ${formatValue(currentValue)}`);
    }
  } else {
    // Set mode — validate key prefix
    const topLevelKey = key.split('.')[0] ?? key;
    if (
      !(SUPPORTED_CONFIG_ROOT_KEYS as readonly string[]).includes(topLevelKey) &&
      !options.force
    ) {
      throw new InvalidArgumentError(
        `Unknown config key prefix: "${topLevelKey}". Known keys: ${SUPPORTED_CONFIG_ROOT_KEYS.join(', ')}. Use --force to set anyway.`
      );
    }

    if (!(SUPPORTED_CONFIG_PATHS as readonly string[]).includes(key) && !options.force) {
      throw new InvalidArgumentError(
        `Unknown config key: "${key}". Known keys: ${SUPPORTED_CONFIG_PATHS.join(', ')}. Use --force to set anyway.`
      );
    }

    const parsedValue = parseValue(value, key);

    try {
      if (options.force) {
        const updatedConfig = mutateConfig(config, key, parsedValue, true);
        await writeConfigDocument(projectRoot, updatedConfig);
      } else {
        const updatedConfig = mutateConfig(config, key, parsedValue);
        await writeConfig(projectRoot, updatedConfig);
      }
    } catch (error: unknown) {
      throw new InvalidArgumentError(`Invalid value for "${key}": ${toError(error).message}`, key);
    }
    success(`Set ${key} = ${formatValue(parsedValue)}`);
  }

  outro('');
}

/** Registers the config command on the CLI program. */
export function registerConfig(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('config <key> [value]')
    .description('Get or set configuration values')
    .option('-f, --force', 'Allow setting unknown config keys')
    .action(
      withErrorHandling(
        async (key: string, value: string | undefined, options: { force?: boolean }) => {
          await configCommand(getProjectRoot(), key, value, pickDefined(options));
        }
      )
    );
}
