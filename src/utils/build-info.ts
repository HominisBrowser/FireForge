// SPDX-License-Identifier: EUPL-1.2
/**
 * Build identity for `--version`.
 *
 * Distinct builds shipping as the same plain semver leave consumers
 * fingerprinting tarballs by sha256 to know which build a claim was verified
 * against. `--version` reports `<semver>+g<short-sha>[.dirty[.<content-hash>]]`:
 *
 * - In a git checkout (dev runs via tsx), identity comes from live git, so a
 *   stale `dist/build-info.json` from an old build must never win.
 * - In an installed package, it comes from `dist/build-info.json`, stamped
 *   by scripts/generate-build-info.mjs at build/pack time.
 * - When neither yields an identity, `--version` degrades to the plain
 *   semver. Reading identity must never throw.
 *
 * Not wired into the per-patch lint cache key: identity would
 * churn the cache on every commit at the same semver for no correctness gain
 * (`getPackageVersion` stays the cache input).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { getPackageRoot, getPackageVersion } from './package-root.js';
import { isObject } from './validation.js';

/** Source identity of the running build. */
interface BuildIdentity {
  shortCommit: string;
  dirty: boolean;
  /**
   * Content hash of the uncommitted diff, present only for a dirty installed
   * build. Two packs from the same HEAD with different uncommitted content
   * share `shortCommit` and the `.dirty` marker, so without this they report
   * byte-identical `--version` strings and a report against
   * `<semver>+g<sha>.dirty` cannot be traced back to a specific pack. Absent
   * in a git checkout: identity there comes from live git, and hashing the
   * full diff on every `--version` call is not worth it.
   */
  dirtyHash?: string;
}

/** @internal Reads the stamped dist/build-info.json. Null when absent/invalid. */
export function readBuildInfoFile(packageRoot: string): BuildIdentity | null {
  try {
    const raw = readFileSync(join(packageRoot, 'dist', 'build-info.json'), 'utf-8');
    const data: unknown = JSON.parse(raw);
    if (!isObject(data) || data['schemaVersion'] !== 1) return null;
    const shortCommit = data['shortCommit'];
    const dirty = data['dirty'];
    if (typeof shortCommit !== 'string' || shortCommit.length === 0) return null;
    const dirtyHash = data['dirtyHash'];
    return {
      shortCommit,
      dirty: dirty === true,
      ...(typeof dirtyHash === 'string' && dirtyHash.length > 0 ? { dirtyHash } : {}),
    };
  } catch {
    return null;
  }
}

type GitRunner = (args: string[]) => string;

const defaultGitRunner: GitRunner = (args) =>
  execFileSync('git', args, {
    cwd: getPackageRoot(),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

/** @internal Live git identity of the checkout. Null when git is unusable. */
export function readGitBuildIdentity(runGit: GitRunner = defaultGitRunner): BuildIdentity | null {
  try {
    const commit = runGit(['rev-parse', 'HEAD']).trim();
    if (!/^[0-9a-f]{7,40}$/.test(commit)) return null;
    const status = runGit(['status', '--porcelain']);
    return { shortCommit: commit.slice(0, 12), dirty: status.length > 0 };
  } catch {
    return null;
  }
}

/**
 * Resolves the running build's identity: live git in a checkout (covers
 * worktrees, whose `.git` is a file), else the stamped build-info file,
 * else null. Never throws.
 */
function getBuildIdentity(): BuildIdentity | null {
  try {
    const packageRoot = getPackageRoot();
    if (existsSync(join(packageRoot, '.git'))) {
      return readGitBuildIdentity();
    }
    return readBuildInfoFile(packageRoot);
  } catch {
    return null;
  }
}

/**
 * @internal Formats `<version>+g<sha>[.dirty[.<hash>]]`. Plain version on
 * null identity. The trailing content hash appears only for a dirty
 * installed build, where `dist/build-info.json` already carries it. Every
 * segment stays valid semver build metadata (dot-separated alphanumerics).
 */
export function formatVersionWithIdentity(version: string, identity: BuildIdentity | null): string {
  if (identity === null) return version;
  if (!identity.dirty) return `${version}+g${identity.shortCommit}`;
  const contentHash = identity.dirtyHash === undefined ? '' : `.${identity.dirtyHash}`;
  return `${version}+g${identity.shortCommit}.dirty${contentHash}`;
}

/** The `--version` string: semver plus build identity when known. */
export function getCliVersion(): string {
  return formatVersionWithIdentity(getPackageVersion(), getBuildIdentity());
}
