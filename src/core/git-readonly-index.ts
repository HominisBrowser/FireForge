// SPDX-License-Identifier: EUPL-1.2
/**
 * Private-index scope for FireForge's READ-ONLY git plumbing.
 *
 * `git status` and `git diff HEAD` are read-only in the sense operators care
 * about — they never change tracked content — but they are NOT read-only to
 * git: both refresh the index's stat cache and write `.git/index` (through
 * `.git/index.lock`) when a file's stat data has moved. That makes
 * `fireforge verify` / `lint --per-patch` / `typecheck` a second WRITER of
 * the primary `engine/` checkout, even when the command was pointed at a CoW
 * tree clone.
 *
 * The consequence is not cosmetic. A concurrent `fireforge test`
 * fingerprints `engine/` before and after the harness run and refuses a
 * verdict taken across a change (`FAIL reason=inconclusive`). That refusal is
 * CORRECT and stays; the defect is FireForge's own read-only commands
 * tripping it.
 *
 * The fix is the standard git one: point the plumbing at a PRIVATE index
 * (`GIT_INDEX_FILE`) seeded from the repository's own, in a temp directory.
 * Refreshes land there and are thrown away; the primary `.git/index` — and
 * `.git/index.lock`, which is what makes a concurrent `git status` fail
 * outright rather than merely churn — is never touched.
 *
 * Fail-open by design: if the git dir or the index cannot be resolved or
 * copied, the scope does not activate and the commands behave exactly as
 * before. A read-only command must not start failing because an optimisation
 * could not be set up.
 *
 * The scope is process-global and non-reentrant on purpose: FireForge
 * commands are one-shot CLI invocations, and nesting two different private
 * indexes for the same run has no meaning. A nested call reuses the outer
 * scope.
 */

import { copyFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { verbose } from '../utils/logger.js';
import { exec } from '../utils/process.js';

/** The active private-index scope, when a read-only command installed one. */
let activeScope: { repoDir: string; indexFile: string } | undefined;

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
  if (activeScope === undefined) return undefined;
  const resolved = resolve(cwd);
  const scoped = activeScope.repoDir;
  if (resolved !== scoped && !resolved.startsWith(`${scoped}/`)) return undefined;
  return { GIT_INDEX_FILE: activeScope.indexFile };
}

/** True while a private-index scope is installed (diagnostics and tests). */
export function hasReadOnlyGitIndexScope(): boolean {
  return activeScope !== undefined;
}

/**
 * Resolves a repository's git directory. Returns undefined for anything
 * that is not a readable git checkout — `engine/` is not always one
 * (`fireforge download` extracts a source tarball).
 */
async function resolveGitDir(repoDir: string): Promise<string | undefined> {
  try {
    const result = await exec('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: repoDir,
      timeout: GIT_DIR_PROBE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
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
  if (activeScope !== undefined) return operation();

  const gitDir = await resolveGitDir(repoDir);
  if (gitDir === undefined) return operation();

  const minted = await mintPrivateIndex(gitDir);
  if (minted === undefined) return operation();

  activeScope = { repoDir: resolve(repoDir), indexFile: minted.indexFile };
  verbose(`Private git index active for ${repoDir} (${minted.indexFile}).`);
  try {
    return await operation();
  } finally {
    activeScope = undefined;
    await minted.dispose();
  }
}

/**
 * A private index file plus the cleanup that removes it.
 *
 * `env` is meant to be handed to a SINGLE git invocation (or a small
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
 * needs to WRITE the index without the write being visible to anyone else.
 *
 * The distinction from {@link withPrivateGitIndex} matters. That one exists
 * so a read-only command's incidental index refreshes do not touch the
 * primary checkout, and it is process-global, non-reentrant, and fail-open,
 * all of which are right for that job. This one serves a caller whose index
 * write is DELIBERATE and whose visibility is the defect: it is per-call, so
 * two concurrent callers cannot collide, and it never depends on an ambient
 * scope having been installed by whichever command happens to be running.
 *
 * The seed is a plain copy, which is safe against a concurrent writer: git
 * writes the index through `index.lock` and an atomic rename, so a reader
 * sees either the old file or the new one, never a torn one. Seeding is
 * REQUIRED rather than merely tidy — an empty index makes a tracked,
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
  if (gitDir === undefined) return undefined;
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
  gitDir: string
): Promise<{ indexFile: string; dispose: () => Promise<void> } | undefined> {
  let tempDir: string | undefined;
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'fireforge-roindex-'));
    const privateIndex = join(tempDir, 'index');
    const sourceIndex = join(gitDir, 'index');
    // A repository with no index yet (a fresh init) is fine: git creates
    // the private one on first use.
    if (await pathExists(sourceIndex)) {
      await copyFile(sourceIndex, privateIndex);
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
