// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import type { JsonValue } from '../types/json.js';
import { toError } from '../utils/errors.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { sha256Hex } from '../utils/hash.js';
import { warn } from '../utils/logger.js';
import { getPackageVersion } from '../utils/package-root.js';
import { getFurnacePaths } from './furnace-config.js';
import { git } from './git-base.js';
import { cacheQualityIdentity } from './jobs/quality-tools.js';
import { collectNewFileCreatorsByPath, type PatchQueueContext } from './patch-lint.js';
import { checkJsWorldDigest, isCheckJsCacheRelevant } from './patch-lint-cache-checkjs.js';

// Schema 5. An entry carries its lintIgnore-suppressed issues and measured
// line count, so a warm run reports waived size measurements exactly as a
// cold run does. The key content-hashes both shim files
// (`patchLint.checkJsExtraShim`, `patchLint.checkJsTestShim`). Each entry
// records the waiver set that produced it and a lookup whose effective set
// differs is refused even when the key matches, because a replayed verdict
// that ignores a fresh waiver is actively wrong. A patch with a
// checkJs-relevant file also keys on the checkJs world its programs read
// (see patch-lint-cache-checkjs.ts): queue order, other patches' modules,
// test heads, `paths` targets and the TypeScript version.
export const LINT_CACHE_SCHEMA_VERSION = 5;
const LINT_IMPLEMENTATION_VERSION = 1;

const LINT_CACHE_DIRNAME = 'lint-cache';
const PER_PATCH_CACHE_FILENAME = 'per-patch-v1.json';

export interface PerPatchLintCacheEntry {
  key: string;
  patchFilename: string;
  issues: PatchLintIssue[];
  /** Issues dropped by the patch's lintIgnore waivers. */
  suppressed: PatchLintIssue[];
  /** Non-binary diff line count measured by the cached lint run. */
  lineCount: number;
  /**
   * Sorted lint-ignore waiver ids in force when this entry was computed.
   * A lookup presenting a different effective set misses.
   */
  lintIgnore: string[];
  updatedAt: string;
}

export interface PerPatchLintCacheFile {
  schemaVersion: typeof LINT_CACHE_SCHEMA_VERSION;
  entries: Record<string, PerPatchLintCacheEntry>;
}

export interface PerPatchLintCacheKeyInput {
  projectRoot: string;
  engineDir: string;
  patchesDir: string;
  patch: PatchMetadata;
  existingFiles: string[];
  config: FireForgeConfig;
  queueContext: PatchQueueContext;
  engineHeadSha?: string;
  packageVersion?: string;
  /** Exact candidate being linted, which can differ from the current patch or engine. */
  diffContent?: string;
}

function stableJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item as JsonValue)}`)
    .join(',')}}`;
}

/** Computes a stable SHA-256 digest for JSON-compatible data. */
function stableHash(value: JsonValue): string {
  return sha256Hex(stableJson(value));
}

/** Returns the repo-local per-patch lint cache file path. */
function getPerPatchLintCachePath(projectRoot: string): string {
  return join(projectRoot, '.fireforge', LINT_CACHE_DIRNAME, PER_PATCH_CACHE_FILENAME);
}

/** Returns the engine git HEAD identity used to guard diff-derived cache hits. */
export async function getPerPatchLintCacheHeadSha(engineDir: string): Promise<string> {
  return (await git(['rev-parse', 'HEAD'], engineDir)).trim();
}

async function fileHash(path: string): Promise<{ exists: boolean; sha256?: string }> {
  if (!(await pathExists(path))) {
    return { exists: false };
  }
  return { exists: true, sha256: sha256Hex(await readFile(path)) };
}

function normalizePatchMetadata(patch: PatchMetadata): JsonValue {
  return {
    filesAffected: patch.filesAffected,
    lintIgnore: patch.lintIgnore as JsonValue | undefined,
    stagedDependencies: patch.stagedDependencies as JsonValue | undefined,
    tier: patch.tier,
  };
}

function normalizeLintConfig(config: FireForgeConfig): JsonValue {
  return {
    binaryName: config.binaryName,
    license: config.license,
    patchLint: config.patchLint as JsonValue | undefined,
  };
}

function isOwnershipRelevantFile(file: string): boolean {
  return file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.jsm');
}

function buildOwnershipFingerprint(
  files: ReadonlyArray<string>,
  ctx: PatchQueueContext
): JsonValue {
  const creators = collectNewFileCreatorsByPath(ctx);
  const entries: Record<string, JsonValue> = {};
  const relevantFiles = [...files]
    .filter(isOwnershipRelevantFile)
    .sort((a, b) => a.localeCompare(b));
  for (const file of relevantFiles) {
    entries[file] = [...(creators.get(file) ?? [])].sort((a, b) => a.localeCompare(b));
  }
  return entries;
}

const unidentifiedTools = new Map<string, string>();

/**
 * The installed-tools part of a lint cache key. Identifying the tools protects a
 * cache, not a verdict: a tree it cannot read means this run misses the cache and
 * lints for real, which is a warning and never a failure. Only an admitted job,
 * whose identity was qualified at admission, still refuses.
 *
 * @param projectRoot - Root whose installed tools are identified
 */
export async function lintQualityIdentity(projectRoot: string): Promise<string> {
  try {
    return await cacheQualityIdentity(projectRoot);
  } catch (error: unknown) {
    if (process.env['FIREFORGE_JOB_TOKEN'] !== undefined) throw error;
    let token = unidentifiedTools.get(projectRoot);
    if (token === undefined) {
      token = `unidentified:${randomUUID()}`;
      unidentifiedTools.set(projectRoot, token);
      warn(
        `Could not identify the installed lint tools (${toError(error).message}); this run does not use the lint cache.`
      );
    }
    return token;
  }
}

/**
 * Builds the complete per-patch lint cache key for one lintable patch.
 * The key includes source, metadata, config, engine state, and ownership
 * inputs, plus the checkJs world when the patch has a checkJs-relevant file.
 * Undefined when that world cannot be fingerprinted: the patch then neither
 * reads nor writes the cache.
 */
export async function buildPerPatchLintCacheKey(
  input: PerPatchLintCacheKeyInput
): Promise<string | undefined> {
  // Hash in parallel, then insert in sorted order. The sort is load-bearing:
  // `stableHash` below serialises this record, so insertion order is part of
  // the cache key, and assigning as results land would make the key
  // nondeterministic.
  const sortedFiles = [...input.existingFiles].sort((a, b) => a.localeCompare(b));
  const hashes = await Promise.all(
    sortedFiles.map((file) => fileHash(join(input.engineDir, file)))
  );
  const engineFiles: Record<string, JsonValue> = {};
  hashes.forEach((hash, index) => {
    const file = sortedFiles[index];
    if (file !== undefined) engineFiles[file] = hash;
  });

  const furnaceConfigPath = getFurnacePaths(input.projectRoot).furnaceConfig;
  const shimHashOf = async (
    shimPath: string | undefined
  ): Promise<{ path: string; hash: { exists: boolean; sha256?: string } } | null> =>
    shimPath === undefined
      ? null
      : { path: shimPath, hash: await fileHash(resolve(input.projectRoot, shimPath)) };
  // Both shims feed compiled checkJs programs, so both are content-hashed.
  // The config block alone only carries their paths, and an in-place edit
  // must invalidate the programs it feeds.
  const [extraShim, testShim] = await Promise.all([
    shimHashOf(input.config.patchLint?.checkJsExtraShim),
    shimHashOf(input.config.patchLint?.checkJsTestShim),
  ]);
  // Only a patch that can carry a checkJs verdict pays for (and is
  // invalidated by) the world its programs read.
  const patchLint = input.config.patchLint;
  const checkJsWorld =
    patchLint?.checkJs === true &&
    input.existingFiles.some((file) => isCheckJsCacheRelevant(file, patchLint))
      ? await checkJsWorldDigest(input.engineDir, patchLint, input.queueContext)
      : null;
  if (checkJsWorld === undefined) return undefined;

  return stableHash({
    resolvedQualityTools: await lintQualityIdentity(input.projectRoot),
    cacheSchemaVersion: LINT_CACHE_SCHEMA_VERSION,
    engineHeadSha: input.engineHeadSha ?? null,
    lintImplementationVersion: LINT_IMPLEMENTATION_VERSION,
    // The plain semver, not the +g<sha> build identity: that identity
    // churns every commit at the same version and would invalidate the
    // cache for no correctness gain.
    packageVersion: input.packageVersion ?? getPackageVersion(),
    patchFile: await fileHash(join(input.patchesDir, input.patch.filename)),
    candidateDiff: sha256Hex(
      input.diffContent ??
        input.queueContext.entries.find((entry) => entry.filename === input.patch.filename)?.diff ??
        ''
    ),
    patchMetadata: normalizePatchMetadata(input.patch),
    lintConfig: normalizeLintConfig(input.config),
    furnaceConfig: await fileHash(furnaceConfigPath),
    checkJsExtraShim: extraShim,
    checkJsTestShim: testShim,
    engineFiles,
    queueOwnership: buildOwnershipFingerprint(input.existingFiles, input.queueContext),
    checkJsWorld,
  });
}

/** Creates an empty cache document using the current cache schema. */
function createEmptyPerPatchLintCache(): PerPatchLintCacheFile {
  return { schemaVersion: LINT_CACHE_SCHEMA_VERSION, entries: {} };
}

function isCacheEntry(value: unknown): value is PerPatchLintCacheEntry {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<PerPatchLintCacheEntry>;
  return (
    typeof entry.key === 'string' &&
    typeof entry.patchFilename === 'string' &&
    Array.isArray(entry.issues) &&
    Array.isArray(entry.suppressed) &&
    typeof entry.lineCount === 'number' &&
    Array.isArray(entry.lintIgnore) &&
    entry.lintIgnore.every((id) => typeof id === 'string') &&
    typeof entry.updatedAt === 'string'
  );
}

/** Loads the per-patch lint cache, treating missing or invalid files as empty. */
export async function loadPerPatchLintCache(projectRoot: string): Promise<PerPatchLintCacheFile> {
  const cachePath = getPerPatchLintCachePath(projectRoot);
  if (!(await pathExists(cachePath))) {
    return createEmptyPerPatchLintCache();
  }
  try {
    const raw = await readJson<unknown>(cachePath);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return createEmptyPerPatchLintCache();
    }
    const candidate = raw as Partial<PerPatchLintCacheFile>;
    if (candidate.schemaVersion !== LINT_CACHE_SCHEMA_VERSION || !candidate.entries) {
      return createEmptyPerPatchLintCache();
    }
    const entries: Record<string, PerPatchLintCacheEntry> = {};
    for (const [filename, entry] of Object.entries(candidate.entries)) {
      if (isCacheEntry(entry)) {
        entries[filename] = entry;
      }
    }
    return { schemaVersion: LINT_CACHE_SCHEMA_VERSION, entries };
  } catch {
    // Any unreadable or malformed cache file is treated as a cold cache. The
    // cache is a pure optimisation, so discarding it is always safe. The
    // alternative is failing lint over a corrupt sidecar.
    return createEmptyPerPatchLintCache();
  }
}

/** Persists the per-patch lint cache atomically through the shared JSON writer. */
export async function savePerPatchLintCache(
  projectRoot: string,
  cache: PerPatchLintCacheFile
): Promise<void> {
  await writeJson(getPerPatchLintCachePath(projectRoot), {
    schemaVersion: LINT_CACHE_SCHEMA_VERSION,
    entries: cache.entries,
  });
}

/** Clears the per-patch lint cache by replacing it with an empty document. */
export async function clearPerPatchLintCache(projectRoot: string): Promise<void> {
  await writeJson(getPerPatchLintCachePath(projectRoot), createEmptyPerPatchLintCache());
}

/** Cached per-patch lint payload returned on a key match. */
export interface CachedPerPatchLint {
  issues: PatchLintIssue[];
  suppressed: PatchLintIssue[];
  lineCount: number;
}

/** Canonical (sorted, de-duplicated) form of a waiver set for comparison. */
function normalizeLintIgnoreSet(lintIgnore: Iterable<string> | undefined): string[] {
  return [...new Set(lintIgnore ?? [])].sort((a, b) => a.localeCompare(b));
}

/**
 * Returns the cached lint payload for a patch when the stored key still
 * matches (never for an undefined key, which no entry answers) and the entry was computed under the same lint-ignore waiver set.
 * A waiver change makes a replayed verdict actively wrong, so the waiver set
 * is compared explicitly rather than trusted to the key.
 */
export function getCachedPerPatchLintIssues(
  cache: PerPatchLintCacheFile,
  patchFilename: string,
  key: string | undefined,
  lintIgnore?: Iterable<string>
): CachedPerPatchLint | undefined {
  if (key === undefined) return undefined;
  const entry = cache.entries[patchFilename];
  if (!entry || entry.key !== key) return undefined;
  const expected = normalizeLintIgnoreSet(lintIgnore);
  const stored = normalizeLintIgnoreSet(entry.lintIgnore);
  if (expected.length !== stored.length || expected.some((id, i) => id !== stored[i])) {
    return undefined;
  }
  return {
    issues: entry.issues.map((issue) => ({ ...issue })),
    suppressed: entry.suppressed.map((issue) => ({ ...issue })),
    lineCount: entry.lineCount,
  };
}

export interface SetCachedPerPatchLintIssuesInput {
  /** Cache file to mutate in place. */
  cache: PerPatchLintCacheFile;
  /** Patch the payload belongs to, and also the cache entry key. */
  patchFilename: string;
  /** Fingerprint the payload is valid for; undefined stores nothing. */
  key: string | undefined;
  /** Reported issues, stored as copies. */
  issues: PatchLintIssue[];
  /** Issues suppressed by `lintIgnore`, stored as copies. */
  suppressed: PatchLintIssue[];
  /** Line count the run measured. */
  lineCount: number;
  /** Suppression ids in force for the run, normalized on store. */
  lintIgnore?: Iterable<string> | undefined;
}

/** Stores the per-patch lint payload after a successful lint calculation. */
export function setCachedPerPatchLintIssues(input: SetCachedPerPatchLintIssuesInput): void {
  const { cache, patchFilename, key, issues, suppressed, lineCount, lintIgnore } = input;
  if (key === undefined) return;
  cache.entries[patchFilename] = {
    key,
    patchFilename,
    issues: issues.map((issue) => ({ ...issue })),
    suppressed: suppressed.map((issue) => ({ ...issue })),
    lineCount,
    lintIgnore: normalizeLintIgnoreSet(lintIgnore),
    updatedAt: new Date().toISOString(),
  };
}
