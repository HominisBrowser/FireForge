// SPDX-License-Identifier: EUPL-1.2
import { ConfigError } from '../errors/config.js';
import { isObject } from '../utils/validation.js';
import { authoredConfigProblem } from './authored/paths.js';
import type { AuthoredSourceConfig } from './authored/types.js';

const SOURCE_FIELDS = new Set(['schemaVersion', 'mode', 'root', 'metadataRoot', 'pristineCommit']);

/** Validates the explicit source authority boundary before any command writes. */
export function parseAuthoredSourceConfig(raw: unknown): AuthoredSourceConfig {
  const problem = authoredConfigProblem(raw);
  if (problem) throw new ConfigError(problem);
  const value = raw as AuthoredSourceConfig;
  if (isObject(raw))
    for (const key of Object.keys(raw))
      if (!SOURCE_FIELDS.has(key)) throw new ConfigError(`Unknown sources field: ${key}`);
  return {
    schemaVersion: 1,
    mode: 'authored',
    root: value.root,
    metadataRoot: value.metadataRoot,
    pristineCommit: value.pristineCommit,
  };
}
