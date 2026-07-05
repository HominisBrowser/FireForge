// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm, select, text } from '@clack/prompts';

import { addLicenseHeaderToFile } from '../core/license-headers.js';
import { findAllPatchesForFiles } from '../core/patch-export.js';
import {
  commentStyleForFile,
  detectNewFilesInDiff,
  isAcceptableNewFileHeader,
  lintExportedPatch,
  resolvePatchSizeTier,
} from '../core/patch-lint.js';
import { resolvePatchOwnedSysMjs } from '../core/patch-lint-ownership.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { getPatchPolicyCategories, isCategoryAllowedByConfig } from '../core/patch-policy.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { PatchesManifest } from '../types/commands/index.js';
import type { ExportOptions, PatchCategory } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { pathExists, readText } from '../utils/fs.js';
import type { SpinnerHandle } from '../utils/logger.js';
import { cancel, info, isCancel, warn } from '../utils/logger.js';
import { PATCH_CATEGORIES, validatePatchName } from '../utils/validation.js';

/**
 * Runs the full patch lint pipeline and reports results.
 * Warnings are always displayed. Errors block the export unless skipLint is true.
 *
 * @param engineDir - Engine root directory
 * @param filesAffected - Files touched by the patch
 * @param diffContent - Raw unified diff string
 * @param config - Project configuration
 * @param skipLint - If true, downgrade errors to warnings
 * @param patchQueueCtx - Optional cross-patch context for ownership resolution
 * @param ignoreChecks - Optional per-patch set of `check` IDs to suppress
 *   (threaded from `PatchMetadata.lintIgnore`). Surgical alternative to
 *   `--skip-lint` when exactly one advisory rule does not apply to a
 *   specific patch — e.g. `large-patch-lines` on a cohesive branding
 *   bundle that genuinely cannot be split.
 * @param patchTier - Optional explicit tier override (threaded from
 *   `PatchMetadata.tier`). Forces the branding-tier thresholds when
 *   set, independent of the auto-detect allowlist. When the branding
 *   tier is applied (either via this opt-in or the auto-detect), a
 *   single `info()` line surfaces the choice so the tier decision is
 *   visible rather than silent.
 */
export async function runPatchLint(
  engineDir: string,
  filesAffected: string[],
  diffContent: string,
  config: FireForgeConfig,
  skipLint?: boolean,
  patchQueueCtx?: import('../core/patch-lint-cross.js').PatchQueueContext,
  ignoreChecks?: ReadonlySet<string>,
  patchTier?: 'branding'
): Promise<void> {
  // Compute the tier decision independently of the lint pipeline so the
  // decision can be surfaced even when the rule body emitted no issues
  // (e.g. a branding patch under the soft threshold still benefits from
  // operators knowing which tier governed the run). The same helper is
  // reused inside `lintPatchSize`, so the surfaced tier and the tier
  // that actually drove the thresholds never drift.
  const tierDecision = resolvePatchSizeTier(filesAffected, patchTier);
  if (tierDecision.tier === 'branding') {
    info(
      tierDecision.source === 'explicit'
        ? 'Lint: branding threshold tier applied via patches.json `tier: "branding"` opt-in.'
        : 'Lint: branding threshold tier applied (patch is all under browser/branding/ plus registration siblings).'
    );
  }

  // When a whole-queue context is supplied, checkJs resolves cross-patch
  // `resource:///`/`chrome://` imports against every patch-owned module, but
  // only this patch's own new modules should report diagnostics. Scope the
  // report to the files this diff creates so re-exporting one patch does not
  // surface another patch's findings (and no ambient stub shim is needed).
  const checkJsReportScope = patchQueueCtx
    ? resolvePatchOwnedSysMjs(detectNewFilesInDiff(diffContent))
    : undefined;

  const issues = await lintExportedPatch(
    engineDir,
    filesAffected,
    diffContent,
    config,
    patchQueueCtx,
    ignoreChecks,
    patchTier,
    checkJsReportScope ? { checkJsReportScope } : undefined
  );
  if (issues.length === 0) return;

  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  const notices = issues.filter((i) => i.severity === 'notice');

  for (const issue of notices) {
    info(`NOTICE [${issue.check}] ${issue.file}: ${issue.message}`);
  }
  for (const issue of warnings) {
    warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
  }

  if (errors.length > 0) {
    for (const issue of errors) {
      if (skipLint) {
        warn(`[${issue.check}] ${issue.file}: ${issue.message}`);
      } else {
        warn(`ERROR [${issue.check}] ${issue.file}: ${issue.message}`);
      }
    }

    if (!skipLint) {
      throw new GeneralError(
        `Patch lint found ${errors.length} error(s) that must be fixed before exporting.\n` +
          'Use --skip-lint to bypass this check.'
      );
    }

    info(`Lint: ${errors.length} error(s) downgraded to warnings (--skip-lint)`);
  } else if (skipLint) {
    // Always announce that --skip-lint was honoured, even when there were
    // no errors to downgrade, so the operator can confirm the flag took
    // effect. Without this, a clean `--skip-lint` run emitted nothing
    // about the flag and looked identical to an unflagged run.
    info('Lint: 0 error(s); --skip-lint is active (no effect on this run).');
  }

  const warnCount = warnings.length + (skipLint ? errors.length : 0);
  if (warnCount > 0) {
    info(`Patch lint: ${warnCount} warning(s)`);
  }
}

/**
 * Resolves patch metadata interactively or from flags, with shared validation.
 * @param options - Export command options
 * @param isInteractive - Whether interactive prompts are allowed
 * @param commandName - Command name for error/help text
 */
export async function promptExportPatchMetadata(
  options: ExportOptions,
  isInteractive: boolean,
  commandName: 'export' | 'export-all',
  config?: FireForgeConfig
): Promise<{ patchName: string; selectedCategory: PatchCategory; description: string } | null> {
  const categories =
    config !== undefined ? getPatchPolicyCategories(config) : [...PATCH_CATEGORIES];
  let patchName = options.name;

  if (patchName) {
    const validationError = validatePatchName(patchName);
    if (validationError) {
      throw new InvalidArgumentError(validationError, '--name');
    }
  }

  if (!patchName && !isInteractive) {
    throw new InvalidArgumentError(
      'The --name flag is required in non-interactive mode',
      `Use: fireforge ${commandName} ${commandName === 'export' ? '<paths...> ' : ''}--name "my-patch-name" --category ${categories[0] ?? 'ui'}`
    );
  }

  if (!patchName) {
    const nameResult = await text({
      message: 'Enter a name for this patch:',
      placeholder: commandName === 'export' ? 'my-change' : 'my-changes',
      validate: (value) => validatePatchName((value ?? '').trim()),
    });

    if (isCancel(nameResult)) {
      cancel('Export cancelled');
      return null;
    }

    patchName = String(nameResult).trim();
  }

  let category = options.category;
  if (category) {
    const isAllowed =
      config !== undefined
        ? isCategoryAllowedByConfig(config, category)
        : (PATCH_CATEGORIES as readonly string[]).includes(category);
    if (!isAllowed) {
      throw new InvalidArgumentError(
        `Invalid category. Must be one of: ${categories.join(', ')}`,
        '--category'
      );
    }
  } else if (!isInteractive) {
    throw new InvalidArgumentError(
      'The --category flag is required in non-interactive mode',
      `Use: fireforge ${commandName} ${commandName === 'export' ? '<paths...> ' : ''}--name "name" --category <${categories.join('|')}>`
    );
  } else {
    const categoryResult = await select({
      message: 'Select a category for this patch:',
      options: categories.map((value) => ({ value, label: value })),
    });

    if (isCancel(categoryResult)) {
      cancel('Export cancelled');
      return null;
    }

    category = categoryResult as PatchCategory;
  }

  let description = options.description ?? '';
  if (!description && isInteractive) {
    const descResult = await text({
      message: 'Enter a description (optional):',
      placeholder: 'Brief description of what this patch does',
    });

    if (!isCancel(descResult)) {
      description = String(descResult);
    }
  }

  return {
    patchName,
    selectedCategory: category,
    description,
  };
}

/**
 * Confirms whether an export may supersede existing patches.
 * @param patchesDir - Patches directory
 * @param filesAffected - Files touched by the pending export
 * @param supersede - Explicit supersede flag from CLI options
 * @param isInteractive - Whether interactive prompts are allowed
 * @param s - Active spinner handle to stop before prompting
 */
export async function confirmSupersedePatches(
  patchesDir: string,
  filesAffected: string[],
  supersede: boolean | undefined,
  isInteractive: boolean,
  s: SpinnerHandle
): Promise<boolean> {
  const wouldSupersede = await findAllPatchesForFiles(patchesDir, filesAffected);
  if (wouldSupersede.length === 0 || supersede) {
    return true;
  }

  s.stop();
  const count = wouldSupersede.length;
  warn(`This export would supersede ${count} existing patch${count === 1 ? '' : 'es'}:`);
  for (const patch of wouldSupersede) {
    warn(`  - ${patch.filename}`);
  }

  if (!isInteractive) {
    throw new GeneralError(
      `Refusing to supersede ${count} patch${count === 1 ? '' : 'es'} in non-interactive mode. ` +
        'Use --supersede to confirm, or use "fireforge re-export" to update existing patches in place.'
    );
  }

  const confirmed = await confirm({
    message: `Supersede ${count} patch${count === 1 ? '' : 'es'}? This cannot be undone.`,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('Export cancelled');
    return false;
  }

  return true;
}

/**
 * Detects new files missing license headers and offers to add them.
 *
 * In interactive mode the user is prompted before any files are modified.
 * In non-interactive mode the function is a no-op — the existing lint error
 * will block the export instead.
 *
 * @param engineDir - Absolute path to engine directory
 * @param diffContent - Current unified diff
 * @param config - Project configuration
 * @param isInteractive - Whether interactive prompts are available
 * @param dryRun - When true, only REPORT missing headers, never prompt or
 *   write. Dry-run must stay read-only: before this flag existed, an
 *   interactive `export --dry-run` prompted (default Yes) and wrote license
 *   headers into engine/ files, then closed with "no changes made".
 * @returns true if files were modified on disk (caller must regenerate diff)
 */
export async function autoFixLicenseHeaders(
  engineDir: string,
  diffContent: string,
  config: FireForgeConfig,
  isInteractive: boolean,
  dryRun = false
): Promise<boolean> {
  const license = config.license ?? 'MPL-2.0';
  const newFiles = detectNewFilesInDiff(diffContent);
  if (newFiles.size === 0) return false;

  const filesToFix: string[] = [];
  for (const file of newFiles) {
    const style = commentStyleForFile(file);
    if (!style) continue;

    const filePath = join(engineDir, file);
    if (!(await pathExists(filePath))) continue;

    const content = await readText(filePath);
    // Same acceptance policy as the missing-license-header rule: offering
    // to "fix" a file the lint already accepts (e.g. a verbatim upstream
    // MPL block header on a derived JS/CSS file) would stack a second
    // header on top of a legitimate one.
    if (!isAcceptableNewFileHeader(file, content, style, license)) {
      filesToFix.push(file);
    }
  }

  if (filesToFix.length === 0) return false;

  if (dryRun) {
    const fileList = filesToFix.map((f) => `  - ${f}`).join('\n');
    info(
      `[dry-run] ${filesToFix.length} new file(s) missing the ${license} license header ` +
        `(a real export would offer to add them):\n${fileList}`
    );
    return false;
  }

  if (!isInteractive) return false;

  const fileList = filesToFix.map((f) => `  - ${f}`).join('\n');
  info(`${filesToFix.length} new file(s) missing the ${license} license header:\n${fileList}`);

  const confirmed = await confirm({
    message: `Add ${license} headers to ${filesToFix.length} file(s)?`,
    initialValue: true,
  });

  if (isCancel(confirmed) || !confirmed) return false;

  for (const file of filesToFix) {
    const style = commentStyleForFile(file);
    if (!style) continue;
    const filePath = join(engineDir, file);
    await addLicenseHeaderToFile(filePath, license, style);
    info(`Added ${license} header to ${file}`);
  }

  return true;
}

/**
 * Maps every file in `filesAffected` to the existing patches that already
 * claim ownership of it, excluding the caller's own patch (when `newFilename`
 * is provided) and any patches that the caller intends to fully supersede.
 *
 * Returns an empty map when no overlap exists. Used by the overlap gate in
 * `export` and `export-all` to refuse a default-mode export that would
 * silently create cross-patch ownership conflicts — the same class of
 * conflict `verify` immediately fails with.
 */
export function findPartialOwnershipOverlap(
  manifest: PatchesManifest,
  filesAffected: string[],
  excludeFilenames: ReadonlySet<string>
): Map<string, string[]> {
  const overlap = new Map<string, string[]>();
  const targetSet = new Set(filesAffected);
  for (const patch of manifest.patches) {
    if (excludeFilenames.has(patch.filename)) continue;
    for (const file of patch.filesAffected) {
      if (!targetSet.has(file)) continue;
      const owners = overlap.get(file) ?? [];
      owners.push(patch.filename);
      overlap.set(file, owners);
    }
  }
  return overlap;
}

/**
 * Gate that refuses the default export path when the new patch would
 * silently claim files that are already tracked by other non-superseded
 * patches. `findAllPatchesForFiles` already catches the full-coverage
 * supersede case — this helper fills the gap for partial overlap, which
 * was the eval finding #12 scenario (two patches both claiming
 * `browser/themes/shared/jar.inc.mn` after a second export with
 * `--before`).
 *
 * Proceeds silently when there is no overlap, or when the caller passed
 * `--allow-overlap`. In interactive mode the caller is prompted to
 * acknowledge the overlap (the proper fix path is `re-export --files` to
 * repartition ownership, so the prompt surfaces that pointer). In
 * non-interactive mode the function throws — better to fail fast than
 * let the queue fall out of sync with verify.
 */
export async function guardOwnershipOverlap(args: {
  patchesDir: string;
  filesAffected: string[];
  supersedingFilenames: ReadonlySet<string>;
  allowOverlap: boolean;
  isInteractive: boolean;
  s: SpinnerHandle;
}): Promise<boolean> {
  const { patchesDir, filesAffected, supersedingFilenames, allowOverlap, isInteractive, s } = args;
  if (allowOverlap) return true;

  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest) return true;

  const overlap = findPartialOwnershipOverlap(manifest, filesAffected, supersedingFilenames);
  if (overlap.size === 0) return true;

  s.stop();
  const entries = [...overlap.entries()].sort(([a], [b]) => a.localeCompare(b));
  warn(
    `This export would create cross-patch ownership overlap on ${String(entries.length)} file${entries.length === 1 ? '' : 's'}:`
  );
  for (const [file, owners] of entries) {
    warn(`  - ${file} already claimed by: ${owners.join(', ')}`);
  }
  warn(
    'The queue would fail `fireforge verify` immediately after this export. ' +
      'To repartition ownership safely, run `fireforge re-export --files <paths> <existing-patch>` ' +
      'on the overlapping patches first, then re-run the export.'
  );

  if (!isInteractive) {
    throw new GeneralError(
      'Refusing to export a queue with cross-patch ownership overlap in non-interactive mode. ' +
        'Pass --allow-overlap to acknowledge the conflict, or repartition ownership via `fireforge re-export --files`.'
    );
  }

  const confirmed = await confirm({
    message:
      'Proceed with overlapping ownership? This will leave the queue in a verify-failing state.',
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('Export cancelled');
    return false;
  }

  return true;
}

/**
 * Runs the two pre-commit gates shared by `export` and `export-all` in
 * order: the supersede confirmation, then the cross-patch ownership
 * overlap guard. The overlap guard receives the filenames of the patches
 * the export would fully supersede so it does not flag a file claimed by
 * a patch that is about to be removed (pre-0.16.0 `export` only caught
 * FULL-coverage supersedes, so a second export targeting a shared file
 * like `browser/themes/shared/jar.inc.mn` created a queue where two
 * patches both claimed the file and `verify` failed immediately).
 *
 * @param args - Gate inputs shared by both export commands
 * @param args.patchesDir - Absolute path of the patches directory
 * @param args.filesAffected - Engine-relative files the export claims
 * @param args.supersede - The command's `--supersede` flag
 * @param args.allowOverlap - The command's `--allow-overlap` flag
 * @param args.isInteractive - Whether prompting the operator is possible
 * @param args.s - Active spinner, stopped before any prompt
 * @returns `true` when both gates passed; `false` when the operator
 *   declined (the caller returns without committing)
 */
export async function runSupersedeAndOverlapGates(args: {
  patchesDir: string;
  filesAffected: string[];
  supersede: boolean | undefined;
  allowOverlap: boolean;
  isInteractive: boolean;
  s: SpinnerHandle;
}): Promise<boolean> {
  const { patchesDir, filesAffected, supersede, allowOverlap, isInteractive, s } = args;

  const shouldProceed = await confirmSupersedePatches(
    patchesDir,
    filesAffected,
    supersede,
    isInteractive,
    s
  );
  if (!shouldProceed) return false;

  const willSupersede = await findAllPatchesForFiles(patchesDir, filesAffected);
  const supersedingFilenames = new Set(willSupersede.map((p) => p.filename));
  return guardOwnershipOverlap({
    patchesDir,
    filesAffected,
    supersedingFilenames,
    allowOverlap,
    isInteractive,
    s,
  });
}
