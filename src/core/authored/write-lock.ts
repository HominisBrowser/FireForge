// SPDX-License-Identifier: EUPL-1.2
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { GeneralError } from '../../errors/base.js';
import { getNodeErrorCode } from '../../utils/errors.js';
import { loadConfig } from '../config.js';
import { withFileLock } from '../file-lock.js';
import { digest } from './git.js';
import { assertNoSourceAliases, assertSourcePath, validateAuthoredConfig } from './paths.js';

export interface AuthoredImage {
  existed: boolean;
  content?: Uint8Array;
  mode?: number;
}
export interface AuthoredTarget {
  root: string;
  path: string;
  file: string;
}
interface MutationObserver {
  before: (images: ReadonlyMap<string, AuthoredImage>) => void;
  after: (images: ReadonlyMap<string, AuthoredImage>) => void;
}
const mutations = new AsyncLocalStorage<MutationObserver>();

/** Keep atomic publication scratch files outside every captured source/metadata root. */
export async function authoredStagingFile(root: string): Promise<string> {
  const directory = '.fireforge/authored-staging';
  await assertNoSourceAliases(root, directory);
  await mkdir(join(root, directory), { recursive: true, mode: 0o700 });
  return join(root, directory, randomUUID());
}

/** Canonical roots and case-folded path keys serialize aliases across processes. */
export async function withAuthoredPathLock<T>(
  projectRoot: string,
  path: string,
  operation: (root: string) => Promise<T>
): Promise<T> {
  assertSourcePath(path);
  const root = await realpath(projectRoot);
  const directory = '.fireforge/authored-writers';
  await assertNoSourceAliases(root, directory);
  const key = digest(path.normalize('NFC').toLocaleLowerCase('en-US'));
  return withFileLock(
    join(root, directory, `${key}.lock`),
    async () => {
      await assertNoSourceAliases(root, directory);
      return operation(root);
    },
    { ownerMetadata: ['command=authored-write', `path=${path}`] }
  );
}

/** The nearest directory at or above `start` holding a project configuration. */
export async function projectRootAbove(start: string): Promise<string | undefined> {
  for (let directory = resolve(start); dirname(directory) !== directory;) {
    try {
      await readFile(join(directory, 'fireforge.json'));
      return directory;
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
    directory = dirname(directory);
  }
  return undefined;
}

/** Resolve only tracked source and authenticated sidecars, never runtime engine output. */
export async function authoredTargetForFile(file: string): Promise<AuthoredTarget | undefined> {
  const absolute = resolve(file);
  const directory = await projectRootAbove(dirname(absolute));
  if (directory === undefined) return undefined;
  const config = await loadConfig(directory);
  if (!config.sources) return undefined;
  validateAuthoredConfig(config.sources);
  const local = relative(directory, absolute).split(sep).join('/');
  const source = `${config.sources.root}/`;
  const declarations = `${config.sources.metadataRoot}/overrides/`;
  const path = local.startsWith(source)
    ? local.slice(source.length)
    : local.startsWith(declarations) && local.endsWith('.json')
      ? local.slice(declarations.length, -5)
      : undefined;
  if (path === undefined) return undefined;
  assertSourcePath(path);
  const root = await realpath(directory);
  await assertNoSourceAliases(root, local);
  return { root, path, file: join(root, local) };
}

/** Snapshot bytes and modes under the caller's cooperative path lock. */
export async function authoredImage(file: string): Promise<AuthoredImage> {
  try {
    const stat = await lstat(file);
    if (!stat.isFile()) throw new GeneralError(`authored-write-kind: ${file}`);
    return { existed: true, content: await readFile(file), mode: stat.mode };
  } catch (error) {
    if (getNodeErrorCode(error) === 'ENOENT') return { existed: false };
    throw error;
  }
}

/** Compare observable postimages; an image recorded without a mode compares by bytes alone. */
export function authoredImageMatches(actual: AuthoredImage, expected: AuthoredImage): boolean {
  return (
    actual.existed === expected.existed &&
    (!expected.existed ||
      (Buffer.from(actual.content ?? []).equals(Buffer.from(expected.content ?? [])) &&
        (expected.mode === undefined || (actual.mode ?? 0) === expected.mode)))
  );
}

/** Attribute postimages only to the current operation; peer operations inherit no journal. */
export function observeAuthoredMutations<T>(
  observer: MutationObserver,
  operation: () => Promise<T>
): Promise<T> {
  return mutations.run(observer, operation);
}

/** Record completed publications before releasing their lock, including partial declaration failures. */
export async function authoredMutationPublished(
  root: string,
  paths: readonly string[]
): Promise<void> {
  return notifyMutation(root, paths, 'after');
}

/** Refuse a journal whose original or previous owned postimage was already replaced by a peer. */
export async function authoredMutationWillPublish(
  root: string,
  paths: readonly string[]
): Promise<void> {
  return notifyMutation(root, paths, 'before');
}

async function notifyMutation(
  root: string,
  paths: readonly string[],
  stage: 'before' | 'after'
): Promise<void> {
  const observer = mutations.getStore();
  if (!observer) return;
  const images = new Map<string, AuthoredImage>();
  for (const path of paths) images.set(join(root, path), await authoredImage(join(root, path)));
  observer[stage](images);
}
