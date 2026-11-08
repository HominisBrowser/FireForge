// SPDX-License-Identifier: EUPL-1.2
import { ConfigError } from '../errors/config.js';

/** Levenshtein distance, bounded to short identifiers. */
function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

/** The closest allowed key, case-insensitively, when it is plausibly the intended one. */
function suggestKey(key: string, allowed: readonly string[]): string | undefined {
  const lower = key.toLowerCase();
  let best: { key: string; distance: number } | undefined;
  for (const candidate of allowed) {
    const distance = editDistance(lower, candidate.toLowerCase());
    if (best === undefined || distance < best.distance) best = { key: candidate, distance };
  }
  return best !== undefined && best.distance <= Math.max(2, Math.floor(key.length / 4))
    ? best.key
    : undefined;
}

/**
 * Rejects any key outside `allowed`. A misspelt key in a gate block would
 * otherwise validate and silently leave the intended gate off.
 *
 * @param keys - Keys present on the raw object
 * @param allowed - Keys the schema defines for this object
 * @param field - Config path of the object, or undefined for the root
 */
export function assertKnownConfigKeys(
  keys: Iterable<string>,
  allowed: readonly string[],
  field?: string
): void {
  for (const key of keys) {
    if (allowed.includes(key)) continue;
    const suggestion = suggestKey(key, allowed);
    const where = field === undefined ? 'fireforge.json' : `Config field "${field}"`;
    throw new ConfigError(
      `${where} has unknown key "${key}"${suggestion === undefined ? '' : `. Did you mean "${suggestion}"?`}`
    );
  }
}
