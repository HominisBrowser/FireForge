// SPDX-License-Identifier: EUPL-1.2
/**
 * Pattern-based translator for cryptic mozbuild / mach errors.
 *
 * Each entry maps a stderr regex to an actionable hint. The goal is not to
 * parse every mach failure — it's to convert the handful of errors whose
 * message is non-obvious into a one-line "here's what to change". New
 * entries should only be added when a concrete diagnosis of the cryptic
 * output has been established; low-confidence hints would train operators
 * to ignore the translator.
 */

/** A single translator entry. */
export interface MachErrorHint {
  /** Pattern to search within the captured mach stderr. */
  pattern: RegExp;
  /** Actionable, one-line hint to surface alongside the raw mach output. */
  hint: string;
}

/**
 * Registered hint patterns. Order-sensitive: the first match wins per
 * pattern, but multiple distinct patterns may fire for the same stderr.
 */
export const MACH_ERROR_HINTS: MachErrorHint[] = [
  {
    pattern: /mozbuild\.preprocessor\.Preprocessor\.Error[\s\S]*?no preprocessor directives found/,
    hint:
      'A file registered under JS_PREFERENCE_PP_FILES contains no preprocessor directives. ' +
      'Use JS_PREFERENCE_FILES instead, or add at least one #filter / #expand directive to the file.',
  },
];

/**
 * Scans captured stderr for known mach errors and returns matching hints.
 * Pure function — safe to call on any string; never throws.
 * @param stderr Captured mach stderr.
 * @returns Ordered, de-duplicated list of hint strings. Empty when nothing matches.
 */
export function explainMachError(stderr: string): string[] {
  if (!stderr) {
    return [];
  }
  const hits: string[] = [];
  const seen = new Set<string>();
  for (const { pattern, hint } of MACH_ERROR_HINTS) {
    if (pattern.test(stderr) && !seen.has(hint)) {
      seen.add(hint);
      hits.push(hint);
    }
  }
  return hits;
}
