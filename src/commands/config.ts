// SPDX-License-Identifier: EUPL-1.2
import { Command } from 'commander';

import {
  configExists,
  loadRawConfigDocument,
  mutateConfig,
  SUPPORTED_CONFIG_PATHS,
  SUPPORTED_CONFIG_ROOT_KEYS,
  validateConfig,
  withConfigFileLock,
  writeConfigDocument,
} from '../core/config.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import { ConfigError } from '../errors/config.js';
import type { CommandContext } from '../types/cli.js';
import type { JsonObject, JsonValue } from '../types/json.js';
import { toError } from '../utils/errors.js';
import { info, intro, outro, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { isJsonObject } from '../utils/validation.js';

/**
 * Gets a nested value from a raw config document using dot notation.
 * @param doc - Document to traverse
 * @param path - Dot-separated path (e.g., "firefox.version")
 * @returns The value at the path, or undefined if not found
 */
function getNestedValue(doc: JsonObject, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = doc;

  for (const part of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = Array.isArray(current) ? current[Number(part)] : current[part];
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
  'firefox.sha256',
  'firefox.candidate',
  'license',
  'wire.subscriptDir',
]);

/**
 * Parses a string value into the appropriate type.
 * Keys listed in STRING_TYPED_KEYS are always stored as strings to prevent
 * accidental type coercion (e.g. `fireforge config firefox.version 128` would
 * otherwise become the number 128 instead of the string "128").
 */
function parseValue(value: string, key?: string): JsonValue {
  // For known string-typed keys, always return as string
  if (key && STRING_TYPED_KEYS.has(key)) {
    return value;
  }

  // Try to parse as JSON first (handles numbers, booleans, arrays, objects).
  try {
    // JSON.parse can only ever produce JSON values.
    const parsed = JSON.parse(value) as JsonValue;
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
function formatValue(value: JsonValue | undefined): string {
  if (value === undefined) {
    return '(not set)';
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
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

  if (value === undefined) {
    // Get mode — read the raw document rather than the validated config so
    // keys persisted via `fireforge config <key> --force` remain readable.
    // `validateConfig` builds a typed clone containing only the known
    // schema fields; relying on it here would silently hide forced-write
    // keys and surface "Unknown config key" on the read even though the
    // key is sitting plainly inside fireforge.json.
    const rawConfig = await loadRawConfigDocument(projectRoot);
    const currentValue = getNestedValue(rawConfig, key);

    if (currentValue === undefined) {
      if ((SUPPORTED_CONFIG_PATHS as readonly string[]).includes(key)) {
        info(`${key} = ${formatValue(currentValue)}`);
        outro('');
        return;
      }
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
    const keyIsKnown = (SUPPORTED_CONFIG_PATHS as readonly string[]).includes(key);

    let unchanged: boolean;
    try {
      // Serialise the read → mutate → write round-trip behind the sidecar
      // config lock so two concurrent `fireforge config` invocations can't
      // each read the pre-state, mutate their own copy, and clobber each
      // other on write. Before the lock, the 2026-04-21 eval reproduced
      // silent data loss with two parallel `fireforge config <key>
      // <value>` commands writing different keys: both exited 0, one key
      // survived, the other vanished. Atomic file writes (temp + rename)
      // were never enough on their own — the lost update happens before
      // the rename, inside the read-modify step. Readers stay lock-free
      // (see `withConfigFileLock` docstring).
      unchanged = await withConfigFileLock(projectRoot, async () => {
        // 2026-04-26 eval Finding 11: short-circuit when the new value
        // matches the current on-disk value. Pre-fix, every set ran
        // through `mutateConfig` + `writeConfig`, which round-trips
        // through `JSON.stringify` and rewrites the file even when no
        // semantic change happened — the rewrite reorders top-level
        // keys (`license`, `markerComment`, etc.) on every harmless
        // re-set, producing diff churn for no reason. The check uses
        // the raw on-disk document so forced-keys round-trip the same
        // as known keys.
        const rawConfig = await loadRawConfigDocument(projectRoot);
        const currentValue = getNestedValue(rawConfig, key);
        if (deepEqual(currentValue, parsedValue)) {
          return true;
        }

        // `--force` is intended as an escape hatch for *unknown* keys; it
        // should not also let the user write a structurally invalid value
        // for a *known* key. Apply strict validation whenever the key is
        // listed in SUPPORTED_CONFIG_PATHS, regardless of --force, and only
        // skip validation for genuinely unknown key paths.
        //
        // BOTH branches seed the mutation from the raw on-disk document.
        // The known-key branch used to round-trip through `loadConfig` →
        // `validateConfig`, which builds a typed clone containing only the
        // known schema fields — so any ordinary `fireforge config <key>
        // <value>` silently dropped every previously --force-written key
        // from fireforge.json (2026-07-05 review, finding H4; the --force
        // branch's comment described this exact hazard for its own path).
        if (options.force && !keyIsKnown) {
          const updatedConfig = mutateConfig(rawConfig, key, parsedValue, true);
          await writeConfigDocument(projectRoot, updatedConfig);
        } else {
          // Mutate the raw document (preserving unknown keys), then run
          // strict validation on the RESULT — validateConfig checks the
          // known schema fields and ignores unknown keys, so this keeps
          // exactly the old validation strength while writing the
          // unstripped document.
          const updatedConfig = mutateConfig(rawConfig, key, parsedValue, true);
          validateConfig(updatedConfig);
          await writeConfigDocument(projectRoot, updatedConfig);
        }
        return false;
      });
    } catch (error: unknown) {
      // Only value/validation problems are the user's "invalid value".
      // Lock-acquisition timeouts and I/O failures must keep their own
      // types/messages — re-labelling a lock timeout as `Invalid value for
      // "<key>"` used to point diagnosis at the value (and return the
      // wrong exit-code class) when the actual problem was a concurrent
      // fireforge process holding the config lock.
      if (error instanceof ConfigError) {
        throw new InvalidArgumentError(
          `Invalid value for "${key}": ${toError(error).message}`,
          key
        );
      }
      throw error;
    }
    if (unchanged) {
      info(`${key} = ${formatValue(parsedValue)} (unchanged)`);
    } else {
      success(`Set ${key} = ${formatValue(parsedValue)}`);
    }
  }

  outro('');
}

/**
 * Structural equality check covering the shapes that
 * `fireforge config` accepts: primitives (strings, numbers, booleans),
 * `null`, arrays of primitives, and nested objects. Used to short-circuit
 * no-op writes (Finding 11) — when the parsed value matches the current
 * on-disk value, skip the mutate + write step entirely.
 */
function deepEqual(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (!isJsonObject(a) || !isJsonObject(b)) {
    // Primitives (and null) compare by identity, handled above.
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
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
