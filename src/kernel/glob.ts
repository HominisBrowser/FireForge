// SPDX-License-Identifier: EUPL-1.2
/**
 * Path globs over forward-slash relative paths. `*` and `?` stay within one
 * segment, `**` crosses segments, and `**` as a whole leading segment matches
 * zero or more directories. A pattern is anchored at both ends: `*.toml`
 * matches only at the top level; prefix it with a `**` segment to match in
 * every directory.
 */
import { escapeRegExp } from './text.js';

const compiled = new Map<string, RegExp>();

/**
 * Compiles a glob to an anchored regular expression.
 *
 * @param glob - The pattern
 */
export function globToRegExp(glob: string): RegExp {
  const cached = compiled.get(glob);
  if (cached !== undefined) return cached;
  let source = '';
  for (let i = 0; i < glob.length; i++) {
    const char = glob.charAt(i);
    if (char === '*' && glob[i + 1] === '*') {
      const wholeSegment = (i === 0 || glob[i - 1] === '/') && glob[i + 2] === '/';
      source += wholeSegment ? '(?:[^/]+/)*' : '.*';
      i += wholeSegment ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(char);
    }
  }
  const expression = new RegExp(`^${source}$`);
  compiled.set(glob, expression);
  return expression;
}

/**
 * Whether `path` matches `glob`.
 *
 * @param path - Forward-slash relative path
 * @param glob - The pattern
 * @param options - With `basename`, a pattern without `/` is matched against
 *   the file name alone, the way ignore files read `*.png`
 */
export function matchesGlob(
  path: string,
  glob: string,
  options: { basename?: boolean } = {}
): boolean {
  const subject =
    options.basename === true && !glob.includes('/') ? path.slice(path.lastIndexOf('/') + 1) : path;
  return globToRegExp(glob).test(subject);
}

/**
 * Whether `path` matches at least one of `globs`.
 *
 * @param path - Forward-slash relative path
 * @param globs - The patterns
 * @param options - See {@link matchesGlob}
 */
export function matchesAnyGlob(
  path: string,
  globs: readonly string[],
  options: { basename?: boolean } = {}
): boolean {
  return globs.some((glob) => matchesGlob(path, glob, options));
}
