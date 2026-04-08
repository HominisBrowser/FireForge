// SPDX-License-Identifier: EUPL-1.2
import { isAbsolute, relative, resolve } from 'node:path';

const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:[\\/]/;
const RELATIVE_PATH_ROOT = resolve('/__fireforge_path_root__');

/** Converts Windows path separators to forward slashes for stable comparisons. */
export function normalizePathSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** Checks whether a path is explicitly absolute on either POSIX or Windows. */
export function isExplicitAbsolutePath(path: string): boolean {
  return isAbsolute(path) || WINDOWS_ABSOLUTE_PATH.test(path);
}

/** Resolves a candidate path and returns whether it stays within the given root. */
export function isPathInsideRoot(root: string, candidate: string): boolean {
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
  if (isExplicitAbsolutePath(path)) {
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
