// SPDX-License-Identifier: EUPL-1.2
/**
 * Safe stale test-harness symlink repair for xpcshell setup failures.
 */

import { isAbsolute, relative, resolve } from 'node:path';

import { isSymlink, removeFile } from '../utils/fs.js';
import { warn } from '../utils/logger.js';

function extractFileExistsDestination(output: string): string | undefined {
  const match =
    /FileExistsError[^\n]*File exists:\s+(?:(?:'[^']*'|"[^"]*")\s*->\s*)?['"]([^'"]+)['"]/i.exec(
      output
    );
  return match?.[1];
}

function isInsideDirectory(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length === 0 || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Removes one stale xpcshell `_tests` symlink when mach reports a
 * FileExistsError during test installation.
 *
 * The guard rails are narrow: only quoted FileExistsError
 * destinations inside the active objdir's `_tests` tree are considered, and
 * only when lstat confirms the destination itself is a symlink.
 */
export async function tryRepairStaleXpcshellTestSymlink(
  engineDir: string,
  objDir: string | undefined,
  output: string
): Promise<boolean> {
  if (!objDir || !/FileExistsError/i.test(output)) return false;
  const destination = extractFileExistsDestination(output);
  if (!destination) return false;

  const resolvedDestination = resolve(destination);
  const testsRoot = resolve(engineDir, objDir, '_tests');
  if (!isInsideDirectory(testsRoot, resolvedDestination)) return false;
  if (!(await isSymlink(resolvedDestination))) return false;

  await removeFile(resolvedDestination);
  warn(
    `Removed stale xpcshell harness symlink under ${objDir}/_tests and retrying mach test once: ${relative(resolve(engineDir), resolvedDestination)}`
  );
  return true;
}
