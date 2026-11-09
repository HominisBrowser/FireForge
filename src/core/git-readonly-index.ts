// SPDX-License-Identifier: EUPL-1.2
/**
 * Private-index scope for FireForge's read-only git plumbing.
 *
 * `git status` and `git diff HEAD` are read-only in the sense operators care
 * about (they never change tracked content), but they are not read-only to
 * git: both refresh the index's stat cache and write `.git/index` (through
 * `.git/index.lock`) when a file's stat data has moved. That makes
 * `fireforge verify` / `lint --per-patch` / `typecheck` a second writer of
 * the primary `engine/` checkout, even when the command was pointed at a CoW
 * tree clone.
 *
 * The consequence is not cosmetic. A concurrent `fireforge test`
 * fingerprints `engine/` before and after the harness run and refuses a
 * verdict taken across a change (`FAIL reason=inconclusive`). That refusal is
 * correct and stays. The defect is FireForge's own read-only commands
 * tripping it.
 *
 * The fix is the standard git one: point the plumbing at a private index
 * (`GIT_INDEX_FILE`) seeded from the repository's own, in a temp directory.
 * Refreshes land there and are thrown away. The primary `.git/index` is
 * never touched, and neither is `.git/index.lock`, which is what makes a
 * concurrent `git status` fail outright rather than merely churn.
 *
 * If repository metadata or the private index cannot be established, the
 * command refuses before its operation begins. A positively confirmed non-Git
 * location or absent engine still gets an empty private index, so queue-only
 * checks work and a concurrently initialized repository stays isolated.
 * An index-bearing repository never falls back to a shared
 * index whose refreshes could invalidate another lane.
 *
 * Async-local scopes isolate concurrent callers and preserve nested repository
 * contexts; same-repository nesting reuses only its own ancestor scope.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { realpathSync } from 'node:fs';
import { copyFile, realpath, stat, utimes } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { GitError } from '../errors/git.js';
import { getNodeErrorCode, toError } from '../utils/errors.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';
import { HERMETIC_GIT_ENV_UNSET, hermeticGitEnvironment } from './git-hermetic.js';

/** The active private-index scope, when a read-only command installed one. */
interface IndexScope {
  repoDir: string;
  indexFile: string;
  parent?: IndexScope;
}
const indexScopes = new AsyncLocalStorage<IndexScope>();

/** Bound on the git-dir probe so a wedged git cannot stall a read-only run. */
const GIT_DIR_PROBE_TIMEOUT_MS = 30_000;

/**
 * Environment overlay a git invocation in `cwd` must carry, or undefined
 * when no private-index scope covers it.
 *
 * Matching is by resolved path prefix: plumbing frequently runs with `cwd`
 * set to a subdirectory of the scoped repository, and those invocations
 * share the same index.
 *
 * @param cwd - Working directory the git process will run in
 * @returns `{ GIT_INDEX_FILE }` when scoped, otherwise undefined
 */
export function readOnlyGitIndexEnv(cwd: string): Record<string, string> | undefined {
  const current = indexScopes.getStore();
  if (current === undefined) return undefined;
  let resolved = resolve(cwd);
  for (let scope: IndexScope | undefined = current; scope; scope = scope.parent)
    if (resolved === scope.repoDir || resolved.startsWith(scope.repoDir + sep))
      return { GIT_INDEX_FILE: scope.indexFile };
  try {
    resolved = realpathSync(cwd);
  } catch {
    return undefined;
  }
  for (let scope: IndexScope | undefined = current; scope; scope = scope.parent)
    if (resolved === scope.repoDir || resolved.startsWith(scope.repoDir + sep))
      return { GIT_INDEX_FILE: scope.indexFile };
  return undefined;
}

/**
 * Resolves a repository's git directory. Returns undefined for anything
 * that is not a readable git checkout. `engine/` is not always one
 * (`fireforge download` extracts a source tarball).
 */
async function resolveGitDir(repoDir: string): Promise<string | null | undefined> {
  try {
    const result = await exec('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repoDir,
      env: hermeticGitEnvironment(),
      envUnset: HERMETIC_GIT_ENV_UNSET,
      timeout: GIT_DIR_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0)
      return /fatal: not a git repository(?:[ (]|$)/i.test(result.stderr) ? null : undefined;
    const gitDir = result.stdout.trim();
    return gitDir.length > 0 ? gitDir : undefined;
  } catch (error: unknown) {
    verbose(`Private git index: could not resolve the git dir — ${toError(error).message}`);
    return undefined;
  }
}

/**
 * Runs `operation` with FireForge's git plumbing pointed at a private
 * index seeded from `repoDir`'s own, so the primary checkout's
 * `.git/index` (and `.git/index.lock`) are never written.
 *
 * @param repoDir - Repository whose plumbing should use a private index
 * @param operation - The read-only command body
 * @returns Whatever `operation` returns
 */
export async function withPrivateGitIndex<T>(
  repoDir: string,
  operation: () => Promise<T>
): Promise<T> {
  let canonical: string,
    absent = false;
  try {
    canonical = await realpath(repoDir);
  } catch (error) {
    if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    canonical = join(await realpath(dirname(repoDir)), basename(repoDir));
    absent = true;
  }
  const parent = indexScopes.getStore();
  for (let scope: IndexScope | undefined = parent; scope; scope = scope.parent)
    if (scope.repoDir === canonical) return operation();
  const gitDir = absent ? null : await resolveGitDir(canonical);
  if (gitDir === undefined)
    throw new GitError(
      'Cannot establish repository metadata for an isolated read-only index',
      'private-index'
    );
  const minted = await mintPrivateIndex(gitDir);
  if (minted === undefined)
    throw new GitError(
      'Cannot create a private read-only index; refusing shared-index fallback',
      'private-index'
    );
  const scope: IndexScope = {
    repoDir: canonical,
    indexFile: minted.indexFile,
    ...(parent ? { parent } : {}),
  };
  try {
    return await indexScopes.run(scope, operation);
  } finally {
    await minted.dispose();
  }
}

/**
 * A private index file plus the cleanup that removes it.
 *
 * `env` is meant to be handed to a single git invocation (or a small
 * sequence of them), rather than installed process-wide the way
 * {@link withPrivateGitIndex} installs a scope.
 */
export interface DisposableGitIndex {
  /** Environment overlay pointing git at the private index. */
  env: Record<string, string>;
  /** Removes the private index. Never throws. */
  dispose: () => Promise<void>;
}

/**
 * Mints a private index seeded from `repoDir`'s own, for a caller that
 * needs to write the index without the write being visible to anyone else.
 *
 * The distinction from {@link withPrivateGitIndex} matters. That one exists
 * so a read-only command's incidental index refreshes do not touch the
 * primary checkout, and it is async-local and fail-closed. This one serves a caller whose index
 * write is intentional and whose visibility is the defect: it is per-call, so
 * two concurrent callers cannot collide, and it never depends on an ambient
 * scope having been installed by whichever command happens to be running.
 *
 * The seed is a plain copy, which is safe against a concurrent writer: git
 * writes the index through `index.lock` and an atomic rename, so a reader
 * sees either the old file or the new one, never a torn one. Seeding is
 * required rather than merely tidy: an empty index makes a tracked,
 * unmodified file look like a fresh add.
 *
 * @param repoDir - Repository whose index should be shadowed
 * @returns The overlay and its cleanup, or undefined when one could not be
 *   minted (a non-git directory, an unreadable index, no writable tmpdir)
 */
export async function mintDisposableGitIndex(
  repoDir: string
): Promise<DisposableGitIndex | undefined> {
  const gitDir = await resolveGitDir(repoDir);
  if (gitDir == null) return undefined;
  const minted = await mintPrivateIndex(gitDir);
  if (minted === undefined) return undefined;
  return { env: { GIT_INDEX_FILE: minted.indexFile }, dispose: minted.dispose };
}

/**
 * Copies `gitDir`'s index into a fresh temp directory. Returns undefined
 * rather than throwing: every caller has a defined behaviour for "no private
 * index available", and none of them wants an exception from an optimisation.
 */
async function mintPrivateIndex(
  gitDir: string | null
): Promise<{ indexFile: string; dispose: () => Promise<void> } | undefined> {
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'fireforge-roindex-'));
    const privateIndex = join(tempDir, 'index');
    const sourceIndex = gitDir === null ? undefined : join(gitDir, 'index');
    // A repository with no index yet (a fresh init) is fine: git creates
    // the private one on first use.
    try {
      if (sourceIndex !== undefined) {
        await copyFile(sourceIndex, privateIndex);
        // Git trusts a same-size file whose second is older than the index's own
        // time, so a copy has to keep that time or it hides a same-second edit.
        const { atime, mtime } = await stat(sourceIndex);
        await utimes(privateIndex, atime, mtime);
      }
    } catch (error) {
      if (getNodeErrorCode(error) !== 'ENOENT') throw error;
    }
    const dir = tempDir;
    return {
      indexFile: privateIndex,
      dispose: async (): Promise<void> => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (error: unknown) {
    verbose(`Private git index unavailable — ${toError(error).message}`);
    if (tempDir !== undefined) await rm(tempDir, { recursive: true, force: true });
    return undefined;
  }
}
