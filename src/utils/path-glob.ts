// SPDX-License-Identifier: EUPL-1.2
/**
 * Minimal path globs for policy config: `*` matches within one path segment,
 * `?` one character of a segment, and `**` any number of whole segments
 * (`a/**` is everything under `a/`, `**\/x` is `x` in any directory). A
 * pattern is anchored at both ends against an engine-relative POSIX path;
 * there is no basename-anywhere matching, so `*.toml` matches only top-level
 * files and `**\/*.toml` matches them everywhere.
 *
 * Hand-rolled because the policy surface needs exactly this much and the
 * package keeps its dependency list short.
 */

import { escapeRegex } from './regex.js';

/** Compiles one glob to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] ?? '';
    if (char === '*' && glob[i + 1] === '*') {
      const atSegmentStart = i === 0 || glob[i - 1] === '/';
      const followedBySlash = glob[i + 2] === '/';
      if (atSegmentStart && followedBySlash) {
        // `**/` : zero or more leading directories.
        source += '(?:[^/]+/)*';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char);
    }
  }
  return new RegExp(`^${source}$`);
}

/** True when `path` matches at least one of `globs`. */
export function matchesAnyGlob(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}
