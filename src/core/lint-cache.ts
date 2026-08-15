// SPDX-License-Identifier: EUPL-1.2
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists, readJson, writeJson } from '../utils/fs.js';
import { getPackageVersion } from '../utils/package-root.js';
import { getFurnacePaths } from './furnace-config.js';
import { git } from './git-base.js';
import { collectNewFileCreatorsByPath, type PatchQueueContext } from './patch-lint.js';

// Schema 2 (FORGE G10): entries additionally carry the lintIgnore-suppressed
// issues and the measured non-binary line count, so a warm run can report
// waived size measurements identically to a cold one (the F5-class hazard:
// a cache hit must never surface LESS than a fresh lint).
// Schema 3 (FORGE H2): the key additionally content-hashes the
// `patchLint.checkJsTestShim` file exactly as `checkJsExtraShim`'s already
// was — before this, editing the test shim in place replayed every cached
// verdict (the same warm-run-reports-less-than-cold hazard class).
export const LINT_CACHE_SCHEMA_VERSION = 3;
const LINT_IMPLEMENTATION_VERSION = 1;

const LINT_CACHE_DIRNAME = 'lint-cache';
const PER_PATCH_CACHE_FILENAME = 'per-patch-v1.json';

export interface PerPatchLintCacheEntry {
  key: string;
  patchFilename: string;
  issues: PatchLintIssue[];
  /** Issues dropped by the patch's lintIgnore waivers (FORGE G10). */
  suppressed: PatchLintIssue[];
  /** Non-binary diff line count measured by the cached lint run. */
  lineCount: number;
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
}

type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

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

/** Computes a SHA-256 hex digest for text or binary content. */
function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
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
    lintIgnore: patch.lintIgnore,
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

/**
 * Builds the complete per-patch lint cache key for one lintable patch.
 * The key includes source, metadata, config, engine state, and ownership inputs.
 */
export async function buildPerPatchLintCacheKey(input: PerPatchLintCacheKeyInput): Promise<string> {
  // Hash in parallel, then insert in sorted order. The sort is load-bearing:
  // `stableHash` below serialises this record, so insertion order is part of
  // the cache key — assigning as results land would make the key
  // nondeterministic. Hashing was strictly sequential until 0.41.0, in the hot
  // path of the cache whose entire purpose is making lint faster.
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
  // Both shims feed compiled checkJs programs, so both are content-hashed —
  // the config block alone only carries their PATHS, and an in-place edit
  // must invalidate the programs it feeds (FORGE H2).
  const [extraShim, testShim] = await Promise.all([
    shimHashOf(input.config.patchLint?.checkJsExtraShim),
    shimHashOf(input.config.patchLint?.checkJsTestShim),
  ]);

  return stableHash({
    cacheSchemaVersion: LINT_CACHE_SCHEMA_VERSION,
    engineHeadSha: input.engineHeadSha ?? null,
    lintImplementationVersion: LINT_IMPLEMENTATION_VERSION,
    // Deliberately the PLAIN semver, not the +g<sha> build identity
    // (FORGE K2): identity churns every commit at the same version and
    // would invalidate the cache for no correctness gain.
    packageVersion: input.packageVersion ?? getPackageVersion(),
    patchFile: await fileHash(join(input.patchesDir, input.patch.filename)),
    patchMetadata: normalizePatchMetadata(input.patch),
    lintConfig: normalizeLintConfig(input.config),
    furnaceConfig: await fileHash(furnaceConfigPath),
    checkJsExtraShim: extraShim,
    checkJsTestShim: testShim,
    engineFiles,
    queueOwnership: buildOwnershipFingerprint(input.existingFiles, input.queueContext),
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
    // cache is a pure optimisation, so discarding it is always safe — the
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

/** Returns the cached lint payload for a patch when the stored key still matches. */
export function getCachedPerPatchLintIssues(
  cache: PerPatchLintCacheFile,
  patchFilename: string,
  key: string
): CachedPerPatchLint | undefined {
  const entry = cache.entries[patchFilename];
  if (!entry || entry.key !== key) return undefined;
  return {
    issues: entry.issues.map((issue) => ({ ...issue })),
    suppressed: entry.suppressed.map((issue) => ({ ...issue })),
    lineCount: entry.lineCount,
  };
}

/** Stores the per-patch lint payload after a successful lint calculation. */
export function setCachedPerPatchLintIssues(
  cache: PerPatchLintCacheFile,
  patchFilename: string,
  key: string,
  issues: PatchLintIssue[],
  suppressed: PatchLintIssue[],
  lineCount: number
): void {
  cache.entries[patchFilename] = {
    key,
    patchFilename,
    issues: issues.map((issue) => ({ ...issue })),
    suppressed: suppressed.map((issue) => ({ ...issue })),
    lineCount,
    updatedAt: new Date().toISOString(),
  };
}
