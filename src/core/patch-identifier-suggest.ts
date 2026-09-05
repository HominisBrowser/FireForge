// SPDX-License-Identifier: EUPL-1.2
/**
 * Builds a concise "patch not found" error message with did-you-mean
 * suggestions in place of the full queue enumeration.
 *
 * Joining every queued patch's filename and manifest name into a
 * comma-separated `Available: ...` tail runs ~1500 characters on a 29-patch
 * queue and buries the actual error. This ranks each known identifier
 * (ordinal, filename with and without `.patch`, manifest name) by
 * Levenshtein distance from the operator's input, surfaces up to three
 * plausible suggestions, and falls back to a count-only summary pointing at
 * `fireforge patch list` when no close match exists.
 */

import type { PatchMetadata } from '../types/commands/index.js';

/** Maximum Levenshtein distance accepted as a "did you mean" suggestion. */
const SUGGESTION_DISTANCE_THRESHOLD = 3;

/**
 * Shortest side accepted for a prefix relation. Below this a prefix match
 * is noise: a one-character ordinal prefixes almost anything.
 */
const MIN_PREFIX_MATCH_LENGTH = 4;

/** Maximum number of suggestions to surface in the error message. */
const SUGGESTION_LIMIT = 3;

/**
 * Computes the Levenshtein edit distance between two strings. Used by
 * `formatPatchNotFoundError` to rank candidate identifiers. The small
 * upper bound on input lengths (filenames, ordinals, names) makes the
 * O(m*n) implementation trivially fast.
 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Allocate the row buffers up-front and fill with zero so every index in
  // [0, b.length] is populated before any read. Using `Array.fill(0)` keeps
  // the type as `number[]` (not `(number | undefined)[]`) so subsequent
  // index reads compose without optional-chaining noise.
  const prev: number[] = new Array<number>(b.length + 1).fill(0);
  const curr: number[] = new Array<number>(b.length + 1).fill(0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const left = curr[j - 1] ?? 0;
      const up = prev[j] ?? 0;
      const diag = prev[j - 1] ?? 0;
      curr[j] = Math.min(left + 1, up + 1, diag + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  return prev[b.length] ?? 0;
}

/**
 * Collects every identifier shape FireForge accepts for a queue entry:
 *   - the ordinal (string form), e.g. `"2"`
 *   - the filename, e.g. `"002-ui-foo.patch"`
 *   - the filename without the `.patch` suffix, e.g. `"002-ui-foo"`
 *   - the manifest `name` field, when distinct from the filename
 * Returned as a flat list so the suggestion ranking can compare each
 * candidate independently.
 */
function collectAcceptedIdentifiers(patches: readonly PatchMetadata[]): string[] {
  const set = new Set<string>();
  for (const patch of patches) {
    set.add(String(patch.order));
    set.add(patch.filename);
    if (patch.filename.endsWith('.patch')) {
      set.add(patch.filename.slice(0, -'.patch'.length));
    }
    if (patch.name && patch.name !== patch.filename) set.add(patch.name);
  }
  return Array.from(set);
}

/**
 * Returns up to {@link SUGGESTION_LIMIT} accepted identifiers ordered
 * by closest Levenshtein distance to {@link identifier}, dropping any
 * candidate whose distance exceeds {@link SUGGESTION_DISTANCE_THRESHOLD}.
 */
function rankSuggestions(identifier: string, candidates: string[]): string[] {
  const needle = identifier.toLowerCase();
  return candidates
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      // Prefix relation in either direction is a stronger signal than edit
      // distance and is not bounded by it: a partial ordinal or an
      // abbreviated slug ("ui-foo" for "002-ui-foo.patch") is many edits away
      // from the full identifier yet is obviously the intended target.
      // `lower.startsWith(needle)`: the operator typed an abbreviation of a
      // real identifier. The reverse relation is only meaningful when the
      // candidate is substantial. Otherwise the single-character ordinal
      // "9" would "match" every input starting with a 9.
      const prefixMatch =
        needle.length >= MIN_PREFIX_MATCH_LENGTH &&
        (lower.startsWith(needle) ||
          (lower.length >= MIN_PREFIX_MATCH_LENGTH && needle.startsWith(lower)));
      return {
        candidate,
        prefixMatch,
        distance: levenshtein(identifier, candidate),
      };
    })
    .filter((entry) => entry.prefixMatch || entry.distance <= SUGGESTION_DISTANCE_THRESHOLD)
    .sort(
      (a, b) =>
        Number(b.prefixMatch) - Number(a.prefixMatch) ||
        a.distance - b.distance ||
        a.candidate.localeCompare(b.candidate)
    )
    .slice(0, SUGGESTION_LIMIT)
    .map((entry) => entry.candidate);
}

/**
 * Formats the user-facing "patch not found" error message used by
 * `patch delete`, `patch reorder`, `patch tier`, and
 * `patch lint-ignore`. Returns a single string suitable for the
 * `InvalidArgumentError` body, never the full queue enumeration.
 */
export function formatPatchNotFoundError(
  identifier: string,
  patches: readonly PatchMetadata[]
): string {
  const accepted = collectAcceptedIdentifiers(patches);
  const suggestions = rankSuggestions(identifier, accepted);
  const lead = `Patch "${identifier}" not found. Accepted identifiers: ordinal (e.g. 2), filename (e.g. 002-ui-foo.patch), or manifest name (e.g. ui-foo).`;
  if (suggestions.length > 0) {
    return `${lead} Did you mean: ${suggestions.join(', ')}? (${patches.length} patches in queue — run "fireforge patch list" for the full list.)`;
  }
  return `${lead} No close match found among ${patches.length} patches in the queue. Run "fireforge patch list" to see them.`;
}
