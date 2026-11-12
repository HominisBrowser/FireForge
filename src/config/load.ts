// SPDX-License-Identifier: EUPL-1.2
/** Reading `fireforge.json`: the raw document and the validated configuration. */
import { join } from 'node:path';

import { ExitCode, FireForgeError, toError } from '../kernel/errors.js';
import { readTextIfExists } from '../kernel/fs.js';
import { isRecord, type JsonObject, parseJson } from '../kernel/json.js';
import { configSchema, type FireForgeConfig } from './schema/index.js';

/** The configuration file's name at the project root. */
export const CONFIG_FILE = 'fireforge.json';

/**
 * Reads `fireforge.json` as a JSON object without validating it, for editing.
 *
 * @param projectRoot - The directory holding the file
 * @returns The document and its text as on disk
 * @throws `config-missing` or `config-invalid` (exit code 2)
 */
export async function readConfigDocument(
  projectRoot: string
): Promise<{ document: JsonObject; text: string }> {
  const path = join(projectRoot, CONFIG_FILE);
  const text = await readTextIfExists(path);
  if (text === undefined) {
    throw new FireForgeError('config-missing', `${path} does not exist`, {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Run "fireforge setup" to create a project.',
    });
  }
  let document;
  try {
    document = parseJson(text, { source: path });
  } catch (error: unknown) {
    throw new FireForgeError('config-invalid', toError(error).message, {
      exitCode: ExitCode.CONFIG_ERROR,
      cause: error,
    });
  }
  if (!isRecord(document)) {
    throw new FireForgeError('config-invalid', `${path} must hold a JSON object`, {
      exitCode: ExitCode.CONFIG_ERROR,
      hint: 'Restore fireforge.json from version control.',
    });
  }
  return { document, text };
}

/**
 * Loads and validates `fireforge.json`, with defaults applied. Every problem
 * in the file is reported at once, each by its key path; an unknown key names
 * the nearest known one.
 *
 * @param projectRoot - The directory holding the file
 * @throws `config-missing` or `config-invalid` (exit code 2)
 */
export async function loadConfig(projectRoot: string): Promise<FireForgeConfig> {
  const { document } = await readConfigDocument(projectRoot);
  return configSchema.parse(document, {
    source: join(projectRoot, CONFIG_FILE),
    code: 'config-invalid',
    exitCode: ExitCode.CONFIG_ERROR,
  });
}
