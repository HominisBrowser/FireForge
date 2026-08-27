// SPDX-License-Identifier: EUPL-1.2
import { isAbsolute, relative, resolve } from 'node:path';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const RELATIVE_PATH_ROOT = resolve('/__fireforge_path_root__');

/**
 * Matches a leading `engine/` or `engine\\` segment (case-insensitive,
 * tolerates leading whitespace). Shared between `register`, `test`, `lint`,
 * and `export` so every command that takes an engine-relative path accepts
 * both the repo-root form (`engine/browser/...`) and the engine-relative
 * form (`browser/...`) without diverging.
 */
const ENGINE_PREFIX_PATTERN = /^\s*engine[/\\]/i;

/** Converts Windows path separators to forward slashes for stable comparisons. */
export function normalizePathSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/**
 * Strips a leading `engine/` (or `engine\\`) segment from a user-supplied
 * path so the same command invocation accepts both repo-root-relative paths
 * (`engine/browser/base/content/foo.js`) and engine-relative paths
 * (`browser/base/content/foo.js`).
 *
 * The match is case-insensitive because default macOS and Windows
 * filesystems treat `Engine/` and `engine/` as the same directory; a literal
 * lowercase-only check leaves `mach` and the manifest writers resolving
 * against a wrongly-cased prefix. Leading whitespace is ignored so
 * tab-completed inputs do not slip past the strip.
 *
 * The return value is trimmed of that leading whitespace when the prefix
 * matched, and otherwise passed through verbatim — callers that care about
 * internal whitespace can trim on their side.
 *
 * @param filePath Path as provided by the user
 * @returns Path relative to the engine directory (or the original when the
 *          prefix was absent)
 */
export function stripEnginePrefix(filePath: string): string {
  const match = ENGINE_PREFIX_PATTERN.exec(filePath);
  if (match) {
    return filePath.slice(match[0].length);
  }
  return filePath;
}

/** Checks whether a path is explicitly absolute on either POSIX or Windows. */
export function isExplicitAbsolutePath(path: string): boolean {
  return isAbsolute(path) || WINDOWS_ABSOLUTE_PATH.test(path);
}

/** Resolves a candidate path and returns whether it stays within the given root. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
  if (candidate.includes('\0')) return false;
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isExplicitAbsolutePath(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);
  const relativePath = relative(resolvedRoot, resolvedCandidate);

  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') &&
      !isAbsolute(relativePath) &&
      !WINDOWS_ABSOLUTE_PATH.test(relativePath))
  );
}

/** Checks whether a relative path stays contained within an arbitrary root. */
export function isContainedRelativePath(path: string): boolean {
  if (isExplicitAbsolutePath(path) || path.includes('\0')) {
    return false;
  }

  return isPathInsideRoot(RELATIVE_PATH_ROOT, path);
}

/** Converts a candidate path to a normalized root-relative path, rejecting escapes. */
export function toRootRelativePath(root: string, candidate: string): string {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = isExplicitAbsolutePath(candidate)
    ? resolve(candidate)
    : resolve(resolvedRoot, candidate);

  if (!isPathInsideRoot(resolvedRoot, resolvedCandidate)) {
    throw new Error(`Path escapes root: ${candidate}`);
  }

  return normalizePathSlashes(relative(resolvedRoot, resolvedCandidate));
}
