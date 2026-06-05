// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import {
  buildPerPatchLintCacheKey,
  getCachedPerPatchLintIssues,
  getPerPatchLintCacheHeadSha,
  loadPerPatchLintCache,
  savePerPatchLintCache,
  setCachedPerPatchLintIssues,
} from '../core/lint-cache.js';
import {
  buildPatchQueueContext,
  lintExportedPatch,
  lintPatchQueue,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { evaluatePatchPolicy } from '../core/patch-policy.js';
import { GeneralError } from '../errors/base.js';
import type { PatchLintIssue, PatchMetadata } from '../types/commands/index.js';
import { pathExists } from '../utils/fs.js';
import { info, outro, success, warn } from '../utils/logger.js';
import type { LintCommandOptions } from './lint.js';

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

/**
 * Lints each patch in the queue as its own isolated diff, honouring
 * per-patch `lintIgnore` entries. Cross-patch rules still run once over
 * the whole queue so queue-level findings are not lost by the rescoping.
 */
export async function lintPerPatch(
  projectRoot: string,
  paths: ReturnType<typeof getProjectPaths>,
  options: LintCommandOptions = {}
): Promise<void> {
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    info('No patches in manifest — nothing to lint per-patch.');
    outro('Nothing to lint');
    return;
  }

  const config = await loadConfig(projectRoot);
  const ctx = await buildPatchQueueContext(paths.patches);
  const cache = options.noCache === true ? undefined : await loadPerPatchLintCache(projectRoot);
  const engineHeadSha = cache ? await getPerPatchLintCacheHeadSha(paths.engine) : undefined;
  let cacheDirty = false;
  let reusedCacheEntries = 0;

  const issues: PatchLintIssue[] = [];
  for (const issue of evaluatePatchPolicy(config, manifest)) {
    issues.push({
      file: issue.filename,
      check: `patch-policy/${issue.code}`,
      message: issue.message,
      severity: issue.severity,
    });
  }

  let linted = 0;
  let skipped = 0;
  for (const patch of manifest.patches) {
    const existing: string[] = [];
    for (const f of patch.filesAffected) {
      if (await pathExists(join(paths.engine, f))) existing.push(f);
    }
    if (existing.length === 0) {
      skipped++;
      continue;
    }

    const ignore = patch.lintIgnore?.length ? new Set<string>(patch.lintIgnore) : undefined;
    let patchIssues: PatchLintIssue[] | undefined;
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
      patchIssues = getCachedPerPatchLintIssues(cache, patch.filename, cacheKey);
      if (patchIssues) {
        reusedCacheEntries++;
        emitTierNotice(patch.filename, existing, patch.tier);
        for (const issue of patchIssues) {
          issues.push({ ...issue, file: `${patch.filename} :: ${issue.file}` });
        }
        linted++;
        continue;
      }
    }

    const diff = await getDiffForFilesAgainstHead(paths.engine, existing);
    if (!diff.trim()) {
      skipped++;
      continue;
    }

    emitTierNotice(patch.filename, existing, patch.tier);

    if (cache && cacheKey) {
      patchIssues = await lintExportedPatch(
        paths.engine,
        existing,
        diff,
        config,
        ctx,
        ignore,
        patch.tier
      );
      setCachedPerPatchLintIssues(cache, patch.filename, cacheKey, patchIssues);
      cacheDirty = true;
    } else {
      patchIssues = await lintExportedPatch(
        paths.engine,
        existing,
        diff,
        config,
        ctx,
        ignore,
        patch.tier
      );
    }
    for (const issue of patchIssues) {
      issues.push({ ...issue, file: `${patch.filename} :: ${issue.file}` });
    }
    linted++;
  }

  issues.push(...lintPatchQueue(ctx));

  if (cache && cacheDirty) await savePerPatchLintCache(projectRoot, cache);
  if (reusedCacheEntries > 0) {
    info(
      `Reused lint cache for ${reusedCacheEntries} patch${reusedCacheEntries === 1 ? '' : 'es'}.`
    );
  }

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
  for (const issue of notices) info(`NOTICE [${issue.check}] ${issue.file}: ${issue.message}`);
  for (const issue of warnings) warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
  for (const issue of errors) warn(`ERROR [${issue.check}] ${issue.file}: ${issue.message}`);

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
