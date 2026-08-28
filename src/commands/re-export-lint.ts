// SPDX-License-Identifier: EUPL-1.2
/**
 * Hoisted + cached lint context for `re-export`.
 *
 * Rebuilding the whole patch-queue context AND a fresh queue-wide checkJs
 * TypeScript program for every patch costs tens of seconds of fixed setup
 * per patch, so an N-patch re-export pays it N times. This module:
 *
 * - builds the queue context and the {@link PerRunCheckJs} program
 *   controller ONCE per invocation (`buildReExportLintContext`) and slices
 *   per-patch findings out of it;
 * - reuses the existing per-patch lint RESULT cache
 *   (`.fireforge/lint-cache/per-patch-v1.json`) across invocations —
 *   re-export lints the identical input `lint --per-patch` does (the fresh
 *   `git diff HEAD` of the owned files), and the key already hashes engine
 *   HEAD, per-file content, patch body, config, shims, and ownership, so a
 *   repeat single re-export is a warm hit. `--no-cache` opts out; run-level
 *   checkJs globals are never cached and are emitted once per invocation;
 * - keeps the in-memory queue context honest after each write
 *   (`refreshQueueCtxEntry`), so later iterations of an `--all` run lint
 *   against the just-refreshed body instead of the stale one.
 */

import { getProjectPaths, loadConfig } from '../core/config.js';
import {
  buildPatchQueueContext,
  countNonBinaryDiffLines,
  detectNewFilesInDiff,
  lintExportedPatch,
  type LintExportedPatchOptions,
  type PatchQueueContext,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import {
  buildPerPatchLintCacheKey,
  getCachedPerPatchLintIssues,
  getPerPatchLintCacheHeadSha,
  loadPerPatchLintCache,
  type PerPatchLintCacheFile,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../core/patch-lint-cache.js';
import { invalidateNewFileCreatorsCache } from '../core/patch-lint-cross.js';
import { extractAddedLinesPerFile } from '../core/patch-lint-diff.js';
import { resolvePatchOwnedSysMjs } from '../core/patch-lint-ownership.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists } from '../utils/fs.js';
import { info } from '../utils/logger.js';
import { reportPatchLintOutcome } from './export-shared.js';
import { buildPerRunCheckJs, type PerRunCheckJs } from './lint-per-run-checkjs.js';

/** Per-invocation lint context, built once and threaded through the loop. */
export interface ReExportLintContext {
  projectRoot: string;
  paths: ReturnType<typeof getProjectPaths>;
  config: FireForgeConfig;
  /** Whole-queue context, built WITH config so the forward-import hints
   * match `lint --per-patch`; undefined when no patches dir. */
  patchQueueCtx: PatchQueueContext | undefined;
  /** Queue-wide checkJs controller; undefined when checkJs is off. */
  checkJs: PerRunCheckJs | undefined;
  /** Per-patch result cache; undefined under `--no-cache`. */
  cache: PerPatchLintCacheFile | undefined;
  engineHeadSha: string | undefined;
  cacheDirty: boolean;
  reusedCacheEntries: number;
  /** Run-level checkJs globals are emitted once per invocation. */
  globalsEmitted: boolean;
}

/** Builds the once-per-invocation lint context. */
export async function buildReExportLintContext(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>,
  noCache: boolean
): Promise<ReExportLintContext> {
  const patchQueueCtx = (await pathExists(paths.patches))
    ? await buildPatchQueueContext(paths.patches, config)
    : undefined;
  const checkJs = patchQueueCtx
    ? buildPerRunCheckJs(projectRoot, paths, config, patchQueueCtx)
    : undefined;
  const cache = noCache ? undefined : await loadPerPatchLintCache(projectRoot);
  const engineHeadSha = cache ? await getPerPatchLintCacheHeadSha(paths.engine) : undefined;
  return {
    projectRoot,
    paths,
    config,
    patchQueueCtx,
    checkJs,
    cache,
    engineHeadSha,
    cacheDirty: false,
    reusedCacheEntries: 0,
    globalsEmitted: false,
  };
}

/** The checkJs-relevant files this fresh diff creates. */
function checkJsFilesInDiff(diffContent: string, checkJs: PerRunCheckJs): Set<string> {
  const files = new Set<string>();
  for (const f of detectNewFilesInDiff(diffContent)) {
    if (checkJs.isRelevant(f)) files.add(f);
  }
  return files;
}

/** Fresh lint payload carried to the post-write cache store. */
export interface ReExportLintResult {
  issues: PatchLintIssue[];
  suppressed: PatchLintIssue[];
  lineCount: number;
  /** Waiver ids in force for this lint run. */
  lintIgnore: string[];
}

/**
 * Lints one re-exported patch body using the hoisted context: cache hit →
 * replay the stored issues through the shared reporter (returns `null`);
 * miss → lint with the queue-wide program's pre-attributed slices (or a
 * per-patch build when the fresh diff creates files the hoisted program
 * never saw — the `--scan` adoption case) and return the payload for
 * {@link storeReExportLintResult}. Throws exactly like `runPatchLint` on
 * errors (unless `skipLint`).
 *
 * The cache key is built over the PROJECTED metadata (current
 * filesAffected, merged lintIgnore, effective tier) so `--tier` /
 * `--lint-ignore` flags change the key. The entry itself is stored AFTER
 * the body write (the key hashes the on-disk `.patch` file, which this
 * very run is about to rewrite — a pre-write store could never match a
 * later run).
 */
export async function lintReExportedPatch(args: {
  lintCtx: ReExportLintContext;
  patch: PatchMetadata;
  projectedMetadata: PatchMetadata;
  existingFiles: string[];
  diffContent: string;
  skipLint?: boolean;
  ignoreChecks?: ReadonlySet<string>;
  patchTier?: 'branding';
}): Promise<ReExportLintResult | null> {
  const { lintCtx, patch, projectedMetadata, existingFiles, diffContent } = args;
  const { paths, config, patchQueueCtx, checkJs, cache } = lintCtx;

  // Tier notice, identical to runPatchLint's head — surfaced on both the
  // cached and fresh paths so the governing tier is never silent.
  const tierDecision = resolvePatchSizeTier(existingFiles, args.patchTier);
  if (tierDecision.tier === 'branding') {
    info(
      tierDecision.source === 'explicit'
        ? 'Lint: branding threshold tier applied via patches.json `tier: "branding"` opt-in.'
        : 'Lint: branding threshold tier applied (patch is all under browser/branding/ plus registration siblings).'
    );
  }

  // Run-level checkJs globals surface exactly once per invocation, never
  // from the cache. On an all-warm run this is a cheap probe,
  // not a program build.
  let globalIssues: PatchLintIssue[] = [];
  if (checkJs && !lintCtx.globalsEmitted) {
    lintCtx.globalsEmitted = true;
    globalIssues = await checkJs.getGlobal();
  }

  if (cache && patchQueueCtx) {
    const cacheKey = await buildPerPatchLintCacheKey({
      projectRoot: lintCtx.projectRoot,
      engineDir: paths.engine,
      patchesDir: paths.patches,
      patch: projectedMetadata,
      existingFiles,
      config,
      queueContext: patchQueueCtx,
      ...(lintCtx.engineHeadSha === undefined ? {} : { engineHeadSha: lintCtx.engineHeadSha }),
    });
    const cached = getCachedPerPatchLintIssues(cache, patch.filename, cacheKey, args.ignoreChecks);
    if (cached) {
      lintCtx.reusedCacheEntries++;
      reportPatchLintOutcome([...globalIssues, ...cached.issues], args.skipLint);
      return null;
    }
  }

  const lintOptions: LintExportedPatchOptions = {};
  const suppressedIssues: PatchLintIssue[] = [];
  lintOptions.onSuppressed = (suppressed) => suppressedIssues.push(...suppressed);

  if (checkJs) {
    const created = checkJsFilesInDiff(diffContent, checkJs);
    const allKnown = [...created].every((f) => checkJs.resolutionSet.has(f));
    if (allKnown) {
      // Slice this patch's findings out of the one queue-wide program.
      lintOptions.precomputedCheckJs = await checkJs.sliceFor(created);
    } else {
      // Fresh `--scan` adoption created checkJs-relevant files the hoisted
      // program has never seen — fall back to a per-patch build with the
      // usual report scope so nothing is silently unchecked.
      lintOptions.checkJsReportScope = resolvePatchOwnedSysMjs(detectNewFilesInDiff(diffContent));
    }
  } else if (patchQueueCtx) {
    lintOptions.checkJsReportScope = resolvePatchOwnedSysMjs(detectNewFilesInDiff(diffContent));
  }

  const issues = await lintExportedPatch(paths.engine, existingFiles, diffContent, config, {
    ...lintOptions,
    ...(patchQueueCtx ? { patchQueueCtx } : {}),
    ...(args.ignoreChecks ? { ignoreChecks: args.ignoreChecks } : {}),
    ...(args.patchTier ? { patchTier: args.patchTier } : {}),
  });

  reportPatchLintOutcome([...globalIssues, ...issues], args.skipLint);
  return {
    issues,
    suppressed: suppressedIssues,
    lineCount: countNonBinaryDiffLines(diffContent).textLines,
    lintIgnore: [...(args.ignoreChecks ?? [])],
  };
}

/**
 * Stores a fresh lint result AFTER the body write, keying against the
 * just-written `.patch` file and the refreshed queue context — the state
 * a later identical invocation will observe (call
 * {@link refreshQueueCtxEntry} first).
 */
export async function storeReExportLintResult(
  lintCtx: ReExportLintContext,
  patchFilename: string,
  projectedMetadata: PatchMetadata,
  existingFiles: string[],
  result: ReExportLintResult
): Promise<void> {
  const { cache, patchQueueCtx, paths, config } = lintCtx;
  if (!cache || !patchQueueCtx) return;
  const cacheKey = await buildPerPatchLintCacheKey({
    projectRoot: lintCtx.projectRoot,
    engineDir: paths.engine,
    patchesDir: paths.patches,
    patch: projectedMetadata,
    existingFiles,
    config,
    queueContext: patchQueueCtx,
    ...(lintCtx.engineHeadSha === undefined ? {} : { engineHeadSha: lintCtx.engineHeadSha }),
  });
  setCachedPerPatchLintIssues(
    cache,
    patchFilename,
    cacheKey,
    result.issues,
    result.suppressed,
    result.lineCount,
    result.lintIgnore
  );
  lintCtx.cacheDirty = true;
}

/**
 * Refreshes the in-memory queue entry for a just-rewritten patch so later
 * iterations (and later cache keys) lint against the new body instead of
 * the stale one. The on-disk write is the authority; this mirrors it.
 */
export function refreshQueueCtxEntry(
  lintCtx: ReExportLintContext,
  patchFilename: string,
  diffContent: string
): void {
  const ctx = lintCtx.patchQueueCtx;
  if (!ctx) return;
  const entry = ctx.entries.find((e) => e.filename === patchFilename);
  if (!entry) return;
  entry.diff = diffContent;
  const newFilePaths = detectNewFilesInDiff(diffContent);
  const addedLinesByFile = extractAddedLinesPerFile(diffContent);
  const newFiles = new Map<string, string>();
  const modifiedFileAdditions = new Map<string, string>();
  for (const [file, lines] of addedLinesByFile) {
    if (newFilePaths.has(file)) {
      // A created file's content IS its added lines.
      newFiles.set(file, lines.join('\n'));
    } else {
      modifiedFileAdditions.set(file, lines.join('\n'));
    }
  }
  entry.newFiles = newFiles;
  entry.modifiedFileAdditions = modifiedFileAdditions;
  invalidateNewFileCreatorsCache(ctx);
}

/** Persists cache writes and reports reuse, once after the loop. */
export async function finishReExportLint(lintCtx: ReExportLintContext): Promise<void> {
  if (lintCtx.cache && lintCtx.cacheDirty) {
    await savePerPatchLintCache(lintCtx.projectRoot, lintCtx.cache);
  }
  if (lintCtx.reusedCacheEntries > 0) {
    info(
      `Reused lint cache for ${lintCtx.reusedCacheEntries} patch${
        lintCtx.reusedCacheEntries === 1 ? '' : 'es'
      }.`
    );
  }
}
