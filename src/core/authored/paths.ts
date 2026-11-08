// SPDX-License-Identifier: EUPL-1.2
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { isObject } from '../../utils/validation.js';
import type { AuthoredSourceConfig, SourceFileMode } from './types.js';

const RESERVED_ROOT_SEGMENTS = new Set(['.git', 'engine', 'node_modules', '.fireforge', 'secrets']);

/** Runtime state and secrets occupy reserved first segments of a project; deeper names mean nothing. */
export function isReservedRootInput(path: string): boolean {
  return RESERVED_ROOT_SEGMENTS.has(path.split('/')[0]?.toLowerCase() ?? '');
}

function assertCanonicalPath(path: string, allowEngineRoot: boolean): void {
  const parts = path.split('/');
  if (
    !path ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    /[\\\0\r\n\t]/.test(path) ||
    posix.normalize(path) !== path ||
    path.endsWith('/') ||
    parts.some(
      (part) => part === '.' || part === '..' || part.toLocaleLowerCase('en-US') === '.git'
    ) ||
    (!allowEngineRoot && parts[0]?.toLocaleLowerCase('en-US') === 'engine')
  ) {
    throw new GeneralError(`authored-invalid-path: ${JSON.stringify(path)}`);
  }
}

/** Canonical authored paths never acquire traversal or runtime-root meanings. */
export function assertSourcePath(path: string): void {
  assertCanonicalPath(path, false);
}

/** Pristine upstream may have a top-level directory named engine, while Git metadata stays forbidden. */
export function assertPristinePath(path: string): void {
  assertCanonicalPath(path, true);
}

/** Reject link, directory and submodule modes at the authored file boundary. */
export function assertSourceMode(mode: string): asserts mode is SourceFileMode {
  if (mode !== '100644' && mode !== '100755') {
    throw new GeneralError(`authored-invalid-mode: ${mode}`);
  }
}

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RESERVED_SOURCE_ROOTS = [
  'engine',
  '.git',
  '.fireforge',
  'node_modules',
  'patches',
  'secrets',
  'components',
  'configs',
];

/** The one set of rules for a `sources` block: the reason it is unacceptable, or undefined. */
export function authoredConfigProblem(value: unknown): string | undefined {
  if (
    !isObject(value) ||
    value['schemaVersion'] !== 1 ||
    value['mode'] !== 'authored' ||
    typeof value['root'] !== 'string' ||
    typeof value['metadataRoot'] !== 'string' ||
    typeof value['pristineCommit'] !== 'string'
  )
    return 'sources requires schemaVersion 1, mode "authored", root, metadataRoot and pristineCommit';
  const folded: string[] = [];
  for (const [field, path] of [
    ['root', value['root']],
    ['metadataRoot', value['metadataRoot']],
  ] as const) {
    try {
      if (path.trim() !== path) throw new GeneralError('surrounding whitespace');
      assertSourcePath(path);
    } catch {
      return `sources.${field} must be a contained canonical relative directory`;
    }
    const lower = path.normalize('NFC').toLocaleLowerCase('en-US');
    if (RESERVED_SOURCE_ROOTS.some((entry) => lower === entry || lower.startsWith(`${entry}/`)))
      return `sources.${field} overlaps a reserved directory`;
    folded.push(lower);
  }
  const [root = '', metadataRoot = ''] = folded;
  if (
    root === metadataRoot ||
    root.startsWith(`${metadataRoot}/`) ||
    metadataRoot.startsWith(`${root}/`)
  )
    return 'sources.root and sources.metadataRoot must be disjoint';
  if (!OBJECT_ID.test(value['pristineCommit']))
    return 'sources.pristineCommit must be a complete lowercase Git object ID';
  return undefined;
}

/** Source and metadata roots must be separate from disposable runtime state. */
export function validateAuthoredConfig(value: unknown): asserts value is AuthoredSourceConfig {
  const problem = authoredConfigProblem(value);
  if (problem) throw new GeneralError(`authored-invalid-config: ${problem}`);
}

/** Refuse existing aliases before a read or mutation, including intermediate links. */
export async function assertNoSourceAliases(
  root: string,
  relative: string,
  options: { allowEngineRoot?: boolean } = {}
): Promise<void> {
  assertCanonicalPath(relative, options.allowEngineRoot === true);
  let current = root;
  for (const part of relative.split('/')) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new GeneralError(`authored-symlink: ${current}`);
    } catch (error: unknown) {
      if (!['ENOENT', 'ENOTDIR'].includes(getNodeErrorCode(error) ?? '')) throw error;
      return;
    }
  }
}

/** Resolve the existing parent rather than trusting a lexical containment check. */
export async function assertOutputBoundary(root: string, path: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const destination = resolve(path);
  if (destination !== absoluteRoot && !destination.startsWith(absoluteRoot + sep)) {
    throw new GeneralError(`authored-output-escape: ${path}`);
  }
  let parent = dirname(destination);
  while (parent !== absoluteRoot) {
    try {
      const canonical = await realpath(parent);
      const canonicalRoot = await realpath(absoluteRoot);
      if (canonical !== canonicalRoot && !canonical.startsWith(canonicalRoot + sep)) {
        throw new GeneralError(`authored-output-escape: ${path}`);
      }
      return;
    } catch (error: unknown) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
      parent = dirname(parent);
    }
  }
}
