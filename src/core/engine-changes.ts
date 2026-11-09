// SPDX-License-Identifier: EUPL-1.2
/**
 * Shared collector for "what changed in the engine tree since the last
 * successful build", used by `build-audit`, `build-prepare` and
 * `test-stale-check`.
 */

import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { PreflightRefusalError } from '../errors/base.js';
import { toError } from '../utils/errors.js';
import type { BuildBaseline } from './build-baseline-types.js';
import { hashEngineFile } from './coverage-records.js';
import { readCommittedChanges, readEngineInventory } from './engine-state.js';
import { gitResult } from './git-base.js';

/**
 * The commit a build record anchors to is not in this engine repository: the
 * engine was downloaded again since, or the commit was pruned. The record then
 * says nothing about this tree, and only a build can make a new one.
 */
export class BaselineAnchorMissingError extends PreflightRefusalError {
  constructor(public readonly commit: string) {
    super(
      `The last recorded build anchors to engine commit ${commit}, which no longer exists in ` +
        'engine/ (re-downloading the engine replaces its repository). Nothing can say the ' +
        'packaged runtime matches engine/ or covers these paths. Run "fireforge build" or ' +
        '"fireforge test --build" first. If you built outside FireForge, --allow-stale-build ' +
        'accepts the runtime as it stands.',
      'no-build-baseline'
    );
  }
}

/** A whole object name, as a build record writes one. Anything else names no commit at all. */
const FULL_OBJECT_NAME = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/**
 * Whether this repository provably lacks the commit: the one git failure that
 * means the record is out of date. Git answers a quiet verify of an absent object
 * with exit 1 and an empty stderr, and complains about one it holds but cannot
 * read, apart from an unreadable pack file, which reads as absent and so is
 * checked here. A malformed record or a damaged store proves nothing about the
 * commit, and stays a failure for the caller to refuse on.
 */
export async function isCommitMissing(engineDir: string, commit: string): Promise<boolean> {
  if (!FULL_OBJECT_NAME.test(commit)) return false;
  try {
    const objects = await gitResult(['rev-parse', '--git-path', 'objects'], engineDir);
    if (objects.exitCode !== 0) return false;
    const packs = resolve(engineDir, objects.stdout.trim(), 'pack');
    for (const name of await readdir(packs)) await access(join(packs, name), constants.R_OK);
    const verify = await gitResult(
      ['rev-parse', '-q', '--verify', `${commit}^{commit}`],
      engineDir
    );
    return verify.exitCode === 1 && verify.stderr.trim() === '';
  } catch {
    // Git could not be asked, or the store could not be read: neither says anything about the commit.
    return false;
  }
}

/**
 * Collects engine-relative paths changed since the baseline's HEAD SHA, plus
 * every workdir modification (tracked and untracked). Git failures refuse the
 * safety decision; a partial inventory never means clean. An anchor commit this
 * repository does not hold raises {@link BaselineAnchorMissingError}, which
 * callers answer as "no usable baseline". With no recorded baseline, worktree
 * status also supports an unborn HEAD. The result is sorted.
 *
 * @param engineDir - Path to the engine directory
 * @param baseline - Last-build baseline, when one exists
 * @param contextLabel - Prefix for the failure message (e.g. `Audit`,
 *   `Auto-configure`, `Stale-build preflight`) so operators can attribute the
 *   probe that failed
 * @returns Sorted engine-relative POSIX paths
 */
export async function collectChangedEnginePaths(
  engineDir: string,
  baseline: BuildBaseline | undefined,
  contextLabel: string
): Promise<string[]> {
  const collected = new Set<string>();
  if (baseline?.engineHeadSha) {
    try {
      for (const path of await readCommittedChanges(engineDir, baseline.engineHeadSha)) {
        collected.add(path);
      }
    } catch (error: unknown) {
      if (await isCommitMissing(engineDir, baseline.engineHeadSha)) {
        throw new BaselineAnchorMissingError(baseline.engineHeadSha);
      }
      throw new Error(
        `${contextLabel}: cannot establish engine changes against baseline ${baseline.engineHeadSha}: ${toError(error).message}`,
        { cause: error }
      );
    }
  }
  try {
    for (const path of (await readEngineInventory(engineDir)).paths) collected.add(path);
  } catch (error: unknown) {
    throw new Error(
      `${contextLabel}: cannot establish complete workdir changes: ${toError(error).message}`,
      { cause: error }
    );
  }
  return [...collected].sort();
}

/**
 * Drops every path whose live content still matches the fingerprint the
 * last successful build recorded for it, keeping the rest. Shared by the
 * stale-build preflight (`packageableFingerprints`) and the auto-configure /
 * full-build escalation in `build-prepare` (`buildInputFingerprints`).
 *
 * A path with no recorded entry, an unreadable file, or a differing hash
 * is kept, since "cannot prove unchanged" must never turn into "unchanged".
 * With no fingerprint set at all (a baseline written before the field
 * existed) every path is kept, which is the path-only comparison the
 * fingerprints refine.
 *
 * @param engineDir - Path to the engine directory
 * @param paths - Candidate engine-relative POSIX paths
 * @param fingerprints - Recorded hashes keyed by engine-relative path
 * @returns The subset of `paths` that cannot be proven unchanged
 */
export async function dropPathsMatchingFingerprints(
  engineDir: string,
  paths: readonly string[],
  fingerprints: Record<string, string> | undefined
): Promise<string[]> {
  if (!fingerprints) return [...paths];
  const kept: string[] = [];
  for (const path of paths) {
    const recorded = fingerprints[path];
    if (recorded === undefined) {
      kept.push(path);
      continue;
    }
    const live = await hashEngineFile(engineDir, path);
    if (live === undefined || live !== recorded) kept.push(path);
  }
  return kept;
}
