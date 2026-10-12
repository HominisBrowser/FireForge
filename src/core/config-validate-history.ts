// SPDX-License-Identifier: EUPL-1.2
import { ConfigError } from '../errors/config.js';
import type { FireForgeConfig } from '../types/config.js';
import type { ParsedRecord } from '../utils/parse.js';
import { isContainedRelativePath } from '../utils/paths.js';

/**
 * Whether a `history.path` value is usable: a non-empty, project-relative
 * path that stays inside the project and names a file, not the root.
 * Shared with the history writer, which reads the raw config and must agree
 * with validation about what it may write to.
 */
export function isValidHistoryPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.trim() !== '.' &&
    !/[\n\r]/.test(value) &&
    isContainedRelativePath(value)
  );
}

/** Parses the optional `history` block. */
export function parseHistoryBlock(rec: ParsedRecord, config: FireForgeConfig): void {
  const raw = rec.raw('history');
  if (raw === undefined) return;
  let historyRec: ParsedRecord;
  try {
    historyRec = rec.object('history');
  } catch {
    throw new ConfigError('Config field "history" must be an object');
  }

  const out: NonNullable<FireForgeConfig['history']> = {};
  const path = historyRec.raw('path');
  if (path !== undefined) {
    if (!isValidHistoryPath(path)) {
      throw new ConfigError(
        'Config field "history.path" must be a project-relative file path inside the project'
      );
    }
    out.path = path;
  }
  config.history = out;
}
