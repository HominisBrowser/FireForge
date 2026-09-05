// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { loadConfig } from '../core/config.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { withPrivateGitIndex } from '../core/git-readonly-index.js';
import {
  buildPatchQueueContext,
  countNonBinaryDiffLines,
  formatPatchLintIssue,
  lintExportedPatch,
  type LintExportedPatchOptions,
  lintPatchQueue,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import type { PerPatchLintCacheFile } from '../core/patch-lint-cache.js';
import {
  buildPerPatchLintCacheKey,
  getCachedPerPatchLintIssues,
  getPerPatchLintCacheHeadSha,
  loadPerPatchLintCache,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../core/patch-lint-cache.js';
import type { PatchQueueContext } from '../core/patch-lint-cross.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { evaluatePatchPolicy } from '../core/patch-policy.js';
import { GeneralError } from '../errors/base.js';
import type { PatchesManifest, PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import type { LintCommandOptions } from '../types/commands/index.js';
import type { FireForgeConfig, ProjectPaths } from '../types/config.js';
import { mapWithConcurrency } from '../utils/concurrency.js';
import { pathExists } from '../utils/fs.js';
import { info, outro, success, warn } from '../utils/logger.js';
import { buildPerRunCheckJs, type PerRunCheckJs } from './lint-per-run-checkjs.js';
import { writePerPatchLintReport } from './lint-report.js';

function buildPerPatchMaxWarningsMessage(
  count: number,
  maxWarnings: number,
  linted: number
): string {
  return (
    `Patch lint found ${count} warning(s) across ${linted} patch(es), exceeding --max-warnings ${maxWarnings}.` +
    ' If this is a release gate, run with --per-patch to identify the owning patch. For intentional staged imports, use patch staged-dependency; for ownership repairs, preview patch move-files, patch reorder --dry-run, or re-export --files --dry-run; add scoped lintIgnore only after review.'
  );
}

function emitTierNotice(filename: string, files: string[], tier: PatchMetadata['tier']): void {
  const decision = resolvePatchSizeTier(files, tier);
  if (decision.tier !== 'branding') return;
  info(
    decision.source === 'explicit'
      ? `${filename}: branding threshold tier applied via patches.json \`tier: "branding"\` opt-in.`
      : `${filename}: branding threshold tier applied (all files under browser/branding/ plus registration siblings).`
  );
}

/** Shared inputs threaded into every per-patch lint invocation. */
interface QueuedPatchLintContext {
  projectRoot: string;
  paths: ProjectPaths;
  config: FireForgeConfig;
  ctx: PatchQueueContext;
  cache: PerPatchLintCacheFile | undefined;
  engineHeadSha: string | undefined;
  /** Queue-wide checkJs program + per-patch attribution; undefined when
   *  `patchLint.checkJs` is off. */
  checkJs: PerRunCheckJs | undefined;
}

/**
 * Per-patch lint outcome carried back from a worker so the orchestrator can
 * apply every side effect (tier notice, issue/cache pushes) deterministically
 * in patch order after the bounded pool drains — concurrency must not reorder
 * the issue rows or the saved cache.
 */
interface QueuedPatchResult {
  status: 'skipped' | 'cached' | 'linted';
  /** Files present on disk; drives the tier notice. Empty when skipped. */
  existingFiles: string[];
  /** Unprefixed issues (from cache or a fresh lint); empty when skipped. */
  rawIssues: PatchLintIssue[];
  /** Issues dropped by the patch's lintIgnore waivers. */
  suppressedIssues: PatchLintIssue[];
  /** Non-binary diff line count; 0 when skipped. */
  lineCount: number;
  /** Present only on a fresh lint with the cache enabled. */
  cacheWrite?: { key: string; lintIgnore: string[] };
  /** True when this patch was freshly linted with checkJs on (built/used the
   *  queue-wide program), so run-level checkJs errors are emitted once here. */
  usedCheckJs: boolean;
}

/**
 * Lints one queued patch against its own isolated diff, reusing the cache entry
 * when the cache key matches. Returns the outcome and the patch's (unprefixed)
 * issues without touching shared state — the orchestrator applies the tier
 * notice, issue prefixing, and cache write in patch order after the pool
 * drains, so the bounded concurrency cannot reorder output. Returns `skipped`
 * (no files present / empty diff), `cached`, or `linted`.
 */
async function lintQueuedPatch(
  patch: PatchMetadata,
  lintCtx: QueuedPatchLintContext
): Promise<QueuedPatchResult> {
  const { projectRoot, paths, config, ctx, cache, engineHeadSha } = lintCtx;
  const present = await mapWithConcurrency(patch.filesAffected, 8, (f) =>
    pathExists(join(paths.engine, f))
  );
  const existing = patch.filesAffected.filter((_, index) => present[index] === true);
  if (existing.length === 0) {
    return {
      status: 'skipped',
      existingFiles: [],
      rawIssues: [],
      suppressedIssues: [],
      lineCount: 0,
      usedCheckJs: false,
    };
  }

  const ignore = patch.lintIgnore?.length ? new Set<string>(patch.lintIgnore) : undefined;
  let cacheKey: string | undefined;
  if (cache) {
    cacheKey = await buildPerPatchLintCacheKey({
      projectRoot,
      engineDir: paths.engine,
      patchesDir: paths.patches,
      patch,
      existingFiles: existing,
      config,
      queueContext: ctx,
      ...(engineHeadSha === undefined ? {} : { engineHeadSha }),
    });
    const cached = getCachedPerPatchLintIssues(cache, patch.filename, cacheKey, ignore);
    if (cached) {
      // Returning before the empty-diff probe below is safe: the cache key
      // hashes every affected engine file's content plus engineHeadSha, so
      // an engine-side revert that would empty the diff always changes the
      // key and misses the cache (pinned by the "engine-side content
      // revert invalidates the per-patch cache" test).
      return {
        status: 'cached',
        existingFiles: existing,
        rawIssues: cached.issues,
        suppressedIssues: cached.suppressed,
        lineCount: cached.lineCount,
        usedCheckJs: false,
      };
    }
  }

  const diff = await getDiffForFilesAgainstHead(paths.engine, existing);
  if (!diff.trim()) {
    return {
      status: 'skipped',
      existingFiles: [],
      rawIssues: [],
      suppressedIssues: [],
      lineCount: 0,
      usedCheckJs: false,
    };
  }

  // checkJs: instead of rebuilding the program per patch, slice this patch's
  // findings out of the one queue-wide program (built lazily on first miss).
  const suppressedIssues: PatchLintIssue[] = [];
  const lintOptions: LintExportedPatchOptions = {
    onSuppressed: (suppressed) => suppressedIssues.push(...suppressed),
  };
  let usedCheckJs = false;
  if (lintCtx.checkJs) {
    const grouped = await lintCtx.checkJs.getGrouped();
    usedCheckJs = true;
    const owned = lintCtx.checkJs.ownedByPatch.get(patch.filename);
    const precomputedCheckJs: PatchLintIssue[] = [];
    if (owned) {
      for (const rel of owned) precomputedCheckJs.push(...(grouped.byFile.get(rel) ?? []));
    }
    lintOptions.precomputedCheckJs = precomputedCheckJs;
  }

  const patchIssues = await lintExportedPatch(paths.engine, existing, diff, config, {
    ...lintOptions,
    patchQueueCtx: ctx,
    ...(ignore ? { ignoreChecks: ignore } : {}),
    ...(patch.tier ? { patchTier: patch.tier } : {}),
  });
  const result: QueuedPatchResult = {
    status: 'linted',
    existingFiles: existing,
    rawIssues: patchIssues,
    suppressedIssues,
    lineCount: countNonBinaryDiffLines(diff).textLines,
    usedCheckJs,
  };
  if (cache && cacheKey) {
    result.cacheWrite = { key: cacheKey, lintIgnore: [...(ignore ?? [])] };
  }
  return result;
}

/** Per-patch lint tallies derived deterministically during result assembly. */
interface PerPatchTotals {
  linted: number;
  skipped: number;
  cacheDirty: boolean;
  reusedCacheEntries: number;
  suppressed: number;
}

/** Size-rule check IDs whose waived measurement is still reported. */
const SUPPRESSED_SIZE_CHECKS = new Set([
  'large-patch-lines',
  'large-patch-files',
  'file-too-large',
]);

/**
 * Applies the per-patch results in patch order so the bounded concurrency
 * cannot reorder output: emits each tier notice, the once-only run-level
 * checkJs errors (before the first freshly linted patch's issues), the
 * filename-prefixed issue rows, and the cache writes — all in the same sequence
 * a serial run produced. Returns the run tallies.
 */
async function applyPerPatchResults(
  subset: PatchMetadata[],
  results: QueuedPatchResult[],
  issues: PatchLintIssue[],
  checkJs: PerRunCheckJs | undefined,
  cache: PerPatchLintCacheFile | undefined
): Promise<PerPatchTotals> {
  const totals: PerPatchTotals = {
    linted: 0,
    skipped: 0,
    cacheDirty: false,
    reusedCacheEntries: 0,
    suppressed: 0,
  };
  let globalCheckJsEmitted = false;
  for (let i = 0; i < subset.length; i++) {
    const patch = subset[i];
    const result = results[i];
    if (!patch || !result) continue;
    if (result.status === 'skipped') {
      totals.skipped++;
      continue;
    }

    emitTierNotice(patch.filename, result.existingFiles, patch.tier);

    // Run-level checkJs errors are emitted once, before the first
    // non-skipped patch's own issues — matching the serial emit point.
    // Deliberately NOT gated on `result.usedCheckJs`: global findings are
    // run-level and never cached, so gating drops them entirely on an
    // all-cache-hit run and lets a warm run report fewer errors than a cold
    // one. PerRunCheckJs builds its program lazily, so the cost only
    // materialises when checkJs is configured.
    if (checkJs && !globalCheckJsEmitted) {
      globalCheckJsEmitted = true;
      issues.push(...(await checkJs.getGlobal()));
    }

    if (result.cacheWrite && cache) {
      setCachedPerPatchLintIssues({
        cache,
        patchFilename: patch.filename,
        key: result.cacheWrite.key,
        issues: result.rawIssues,
        suppressed: result.suppressedIssues,
        lineCount: result.lineCount,
        lintIgnore: result.cacheWrite.lintIgnore,
      });
      totals.cacheDirty = true;
    }

    for (const issue of result.rawIssues) {
      issues.push({ ...issue, file: `${patch.filename} :: ${issue.file}` });
    }

    // A waived size finding still reports its MEASUREMENT: the finding stays
    // suppressed (no exit-code / --max-warnings effect) but the current count
    // is readable from the tool that enforces it, so a waiver's cited size
    // can be calibrated without hand-measuring.
    for (const suppressedIssue of result.suppressedIssues) {
      if (!SUPPRESSED_SIZE_CHECKS.has(suppressedIssue.check)) continue;
      info(
        `NOTICE [${suppressedIssue.check}] ${patch.filename}: suppressed by lintIgnore — ${suppressedIssue.message}`
      );
    }
    totals.suppressed += result.suppressedIssues.length;

    if (result.status === 'cached') totals.reusedCacheEntries++;
    totals.linted++;
  }
  return totals;
}

/**
 * Maximum patches linted concurrently. After the per-file→batched git change,
 * each patch is only a handful of git spawns, so a small pool overlaps their
 * I/O without oversubscribing git on the shared repository.
 */
const PER_PATCH_LINT_CONCURRENCY = 8;

/**
 * Lints every patch in `subset` with bounded concurrency, returning results in
 * patch order (each slot index matches `subset`). Mirrors the worker-pool idiom
 * used by the rollback restore path. Side effects are deferred to the caller so
 * issue ordering and cache writes stay deterministic.
 */
async function lintSubsetConcurrently(
  subset: PatchMetadata[],
  lintCtx: QueuedPatchLintContext
): Promise<QueuedPatchResult[]> {
  const results = new Array<QueuedPatchResult>(subset.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < subset.length) {
      const current = index++;
      const patch = subset[current];
      if (!patch) break;
      results[current] = await lintQueuedPatch(patch, lintCtx);
    }
  }
  const workers = Array.from({ length: Math.min(PER_PATCH_LINT_CONCURRENCY, subset.length) }, () =>
    worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Reporting + exit phase of per-patch lint: renders every issue row,
 * prints the per-patch summary, and applies the failure criteria
 * (errors, `--max-warnings`) by throwing GeneralError.
 */
function reportPerPatchOutcome(
  issues: PatchLintIssue[],
  linted: number,
  skipped: number,
  options: LintCommandOptions
): void {
  if (issues.length === 0) {
    if (linted === 0 && skipped > 0) {
      info(
        `No patches in the queue have been applied to engine/. Run "fireforge import" first if you want lint findings against the staged hunks; otherwise this is expected.`
      );
    }
    const summary =
      skipped > 0
        ? `No lint issues found across ${linted} patch(es) (${skipped} skipped — files not present in engine/).`
        : `No lint issues found across ${linted} patch(es).`;
    success(summary);
    outro('Lint passed');
    return;
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const notices = issues.filter((i) => i.severity === 'notice');
  for (const issue of notices) info(`NOTICE ${formatPatchLintIssue(issue)}`);
  for (const issue of warnings) warn(formatPatchLintIssue(issue));
  for (const issue of errors) warn(`ERROR ${formatPatchLintIssue(issue)}`);

  info(
    `\nLint (per-patch over ${linted} patch(es)): ${errors.length} error(s), ${warnings.length} warning(s)`
  );

  if (errors.length > 0) {
    outro('Lint failed');
    throw new GeneralError(
      `Patch lint found ${errors.length} error(s) across ${linted} patch(es). Fix these before exporting.`
    );
  }

  if (options.maxWarnings !== undefined && warnings.length > options.maxWarnings) {
    outro('Lint failed');
    throw new GeneralError(
      buildPerPatchMaxWarningsMessage(warnings.length, options.maxWarnings, linted)
    );
  }

  if (warnings.length > 0) {
    outro('Lint passed with warnings');
  } else if (notices.length > 0) {
    outro('Lint passed with notices');
  } else {
    outro('Lint passed');
  }
}

/**
 * Resolves the `--patches <name…>` subset filter against the manifest,
 * matching each requested name tolerantly (exact filename, filename ±
 * `.patch`, the bare order number, or the manifest `name` field). Throws listing the available
 * patches when a requested name matches none, so a typo fails loud rather
 * than silently linting nothing.
 */
function selectPatchSubset(
  manifest: PatchesManifest,
  requested: readonly string[]
): PatchMetadata[] {
  const normalizedRequests = requested
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const patchAliases = (p: PatchMetadata): Set<string> => {
    const aliases = new Set<string>([p.filename, p.filename.replace(/\.patch$/, ''), p.name]);
    // The bare order number, both as the manifest records it and as the
    // filename spells it (`2` and `002`). The refusal message offers stems,
    // and an operator reading `102-ui-canvas-tiles.patch` in a lint finding
    // reaches for `102` first.
    aliases.add(String(p.order));
    const match = /^(\d+)-([a-z]+)-(.+)\.patch$/.exec(p.filename);
    if (match?.[1]) aliases.add(match[1]);
    if (match?.[2] && match[3]) {
      aliases.add(`${match[2]}-${match[3]}`);
      aliases.add(match[3]);
    }
    return aliases;
  };

  const matches = (p: PatchMetadata, name: string): boolean => {
    const stem = name.replace(/\.patch$/, '');
    return (
      patchAliases(p).has(name) || patchAliases(p).has(stem) || patchAliases(p).has(`${stem}.patch`)
    );
  };

  const selected: PatchMetadata[] = [];
  const seen = new Set<string>();
  for (const name of normalizedRequests) {
    const found = manifest.patches.filter((p) => matches(p, name));
    if (found.length === 0) {
      const available = manifest.patches.map((p) => p.filename).join(', ');
      throw new GeneralError(
        `No patch in the queue matches "${name}". In --per-patch mode, positional arguments ` +
          `and --patches select patches (filename, stem, order number, manifest name, or slug) — not engine ` +
          `files; drop --per-patch to lint engine paths. Available patches: ${available}`
      );
    }
    for (const p of found) {
      if (!seen.has(p.filename)) {
        seen.add(p.filename);
        selected.push(p);
      }
    }
  }
  return selected;
}

/**
 * Lints each patch in the queue as its own isolated diff, honouring
 * per-patch `lintIgnore` entries. Cross-patch rules still run once over
 * the whole queue so queue-level findings are not lost by the rescoping.
 * With `options.patches` set, only the named subset is linted (and the
 * queue-level findings are scoped to files those patches touch).
 */
export async function lintPerPatch(
  projectRoot: string,
  paths: ProjectPaths,
  options: LintCommandOptions = {}
): Promise<void> {
  // Read-only to the operator, an index WRITER to git: the per-patch diffs
  // run `git diff HEAD` (and, for untracked binaries, a real stage/unstage
  // pair) against the primary checkout. A private index absorbs all of it
  // so a concurrent `fireforge test` still gets an evidential verdict.
  return withPrivateGitIndex(paths.engine, () => lintPerPatchInner(projectRoot, paths, options));
}

async function lintPerPatchInner(
  projectRoot: string,
  paths: ProjectPaths,
  options: LintCommandOptions = {}
): Promise<void> {
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    info('No patches in manifest — nothing to lint per-patch.');
    outro('Nothing to lint');
    return;
  }

  const subset =
    options.patches && options.patches.length > 0
      ? selectPatchSubset(manifest, options.patches)
      : manifest.patches;
  const subsetNames = new Set(subset.map((p) => p.filename));
  const isSubset = subset.length !== manifest.patches.length;

  const config = await loadConfig(projectRoot);
  const ctx = await buildPatchQueueContext(paths.patches, config);

  // Queue-level findings (policy, cross-patch) are scoped to the requested
  // subset: a 5-patch slice should not fail on a policy or forward-import
  // problem owned entirely by patches the operator did not target.
  const subsetTouchedFiles = new Set<string>();
  if (isSubset) {
    for (const entry of ctx.entries) {
      if (!subsetNames.has(entry.filename)) continue;
      for (const f of entry.newFiles.keys()) subsetTouchedFiles.add(f);
      for (const f of entry.modifiedFileAdditions.keys()) subsetTouchedFiles.add(f);
    }
  }

  const cache = options.noCache === true ? undefined : await loadPerPatchLintCache(projectRoot);
  const engineHeadSha = cache ? await getPerPatchLintCacheHeadSha(paths.engine) : undefined;
  const issues: PatchLintIssue[] = [];
  for (const issue of evaluatePatchPolicy(config, manifest)) {
    if (isSubset && !subsetNames.has(issue.filename)) continue;
    issues.push({
      file: issue.filename,
      check: `patch-policy/${issue.code}`,
      message: issue.message,
      severity: issue.severity,
    });
  }

  // With `--patches`, the checkJs program roots at only the subset's owned
  // files — the full queue stays resolvable, so a cold subset run costs the
  // subset's import closure instead of the whole queue.
  const checkJs = buildPerRunCheckJs(
    projectRoot,
    paths,
    config,
    ctx,
    isSubset ? subsetNames : undefined
  );

  // Lint patches concurrently, then apply every side effect in patch order so
  // the issue rows, the run-level checkJs errors, and the saved cache are
  // identical to a serial run.
  const results = await lintSubsetConcurrently(subset, {
    projectRoot,
    paths,
    config,
    ctx,
    cache,
    engineHeadSha,
    checkJs,
  });

  const { linted, skipped, cacheDirty, reusedCacheEntries, suppressed } =
    await applyPerPatchResults(subset, results, issues, checkJs, cache);

  for (const issue of lintPatchQueue(ctx)) {
    if (isSubset && !subsetTouchedFiles.has(issue.file)) continue;
    issues.push(issue);
  }

  if (cache && cacheDirty) await savePerPatchLintCache(projectRoot, cache);
  if (reusedCacheEntries > 0) {
    info(
      `Reused lint cache for ${reusedCacheEntries} patch${reusedCacheEntries === 1 ? '' : 'es'}.`
    );
  }
  if (suppressed > 0) {
    info(`Suppressed ${suppressed} issue(s) via per-patch lintIgnore.`);
  }

  if (options.report !== undefined) {
    await writePerPatchLintReport(options.report, subset, results);
  }

  reportPerPatchOutcome(issues, linted, skipped, options);
}
