// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, updateState } from '../core/config.js';
import { getHead } from '../core/git.js';
import { getDirtyFiles } from '../core/git-status.js';
import {
  applyPatchesWithContinue,
  computePatchedContent,
  countPatches,
  discoverPatches,
  extractAffectedFiles,
  PatchError,
} from '../core/patch-apply.js';
import {
  checkVersionCompatibility,
  loadPatchesManifest,
  validatePatchesManifestConsistency,
  validatePatchIntegrity,
} from '../core/patch-manifest.js';
import { getPatchSourceVersion } from '../core/patch-source-metadata.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ImportOptions, PatchesManifest } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { pathExists, readText } from '../utils/fs.js';
import {
  error,
  info,
  intro,
  isCancel,
  outro,
  spinner,
  success,
  verbose,
  warn,
} from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Errno codes for filesystem-level failures against the working file.
 * These are safe to fall through as "unmanaged" because they describe the
 * *state of the engine directory*, not the integrity of the patch stack.
 * Manifest / patch-parse / PatchError failures do NOT match this set and
 * are re-thrown so the root cause surfaces instead of being silently
 * reclassified as a spurious dirty file.
 */
const SAFE_IO_FALLBACK_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'EBUSY']);

function isSafeIoFallback(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && SAFE_IO_FALLBACK_CODES.has(code);
}

async function getUnmanagedDirtyFiles(
  engineDir: string,
  patchesDir: string,
  dirtyFiles: string[]
): Promise<string[]> {
  const classifications = await Promise.all(
    dirtyFiles.map(async (file) => {
      try {
        const [expected, exists] = await Promise.all([
          computePatchedContent(patchesDir, engineDir, file),
          pathExists(join(engineDir, file)),
        ]);
        const actual = exists ? await readText(join(engineDir, file)) : null;
        return actual === expected ? null : file;
      } catch (error: unknown) {
        // PatchError, manifest corruption, and patch-parse failures are
        // *structural* problems with the patch stack — masking them as
        // "unmanaged dirty file" would let the user `--force` past a real
        // root cause (e.g. "patch 003 missing from manifest") and compound
        // the corruption. Only swallow the pure-IO fallback cases where
        // the working file itself can't be read.
        if (error instanceof PatchError) {
          throw error;
        }
        if (!isSafeIoFallback(error)) {
          throw error;
        }
        verbose(
          `Treating ${file} as unmanaged because patched-content classification failed with IO error: ${toError(error).message}`
        );
        return file;
      }
    })
  );

  return classifications.filter((file): file is string => file !== null).sort();
}

function reportForcedOverwriteRisk(unmanagedDirtyFiles: string[]): void {
  warn(
    `--force will overwrite ${unmanagedDirtyFiles.length} unmanaged change${unmanagedDirtyFiles.length === 1 ? '' : 's'} in patch-touched file${unmanagedDirtyFiles.length === 1 ? '' : 's'}:`
  );
  for (const file of unmanagedDirtyFiles) {
    warn(`  ${file}`);
  }
  warn(
    'Patch reapplication may restore these paths to the engine baseline before reapplying patches.'
  );
}

async function checkUncommittedPatchFiles(
  engineDir: string,
  patchesDir: string,
  forceImport: boolean
): Promise<void> {
  const patches = await discoverPatches(patchesDir);
  const allTouchedFiles = new Set<string>();
  for (const patch of patches) {
    const content = await readText(patch.path);
    for (const file of extractAffectedFiles(content)) {
      allTouchedFiles.add(file);
    }
  }

  if (allTouchedFiles.size > 0) {
    const dirtyFiles = await getDirtyFiles(engineDir, [...allTouchedFiles]);
    if (dirtyFiles.length > 0) {
      const unmanagedDirtyFiles = await getUnmanagedDirtyFiles(engineDir, patchesDir, dirtyFiles);

      if (unmanagedDirtyFiles.length === 0) {
        // Common path here: operator just ran `fireforge resolve` to
        // regenerate a patch from manual conflict edits, so the engine
        // already carries the patch's effects. The import below will
        // still re-apply each patch (a no-op for files whose contents
        // already match), so phrase the line as "no resync needed"
        // rather than "patches already applied" — the latter contradicts
        // the "Applied N patch(es)" summary `applyPatchesWithContinue`
        // prints next, which the 2026-04-25 eval flagged as ambiguous.
        info(
          'Patch-touched files already match the stored patch stack — no engine resync needed before re-applying.'
        );
      } else if (!forceImport) {
        warn('Uncommitted changes detected in files that patches will modify:');
        for (const file of unmanagedDirtyFiles) {
          warn(`  ${file}`);
        }
        throw new GeneralError(
          'Uncommitted changes in patch-touched files. Commit or stash them first, or use --force.'
        );
      } else {
        reportForcedOverwriteRisk(unmanagedDirtyFiles);
      }
    }
  }
}

async function handlePatchFailures(
  summary: Awaited<ReturnType<typeof applyPatchesWithContinue>>,
  projectRoot: string
): Promise<void> {
  const firstFailed = summary.failed[0];

  if (firstFailed) {
    // Transactional update rather than `loadState` + mutate + `saveState`. The
    // caller captures `state` at the start of the import run, and the run can
    // span a long window (drift-check prompt, patch apply loop). A concurrent
    // command (`fireforge download`, `rebase`, another state mutation) writing
    // unrelated fields during that window would be silently clobbered when the
    // stale state object was written back.
    await updateState(projectRoot, (current) => ({
      ...current,
      pendingResolution: {
        patchFilename: firstFailed.patch.filename,
        originalError: firstFailed.error ?? 'Unknown error',
      },
    }));
  }

  for (const result of summary.failed) {
    error(`\nFailed: ${result.patch.filename}`);
    if (result.error) {
      error(`  Error: ${result.error}`);
    }
    if (result.conflictingFiles && result.conflictingFiles.length > 0) {
      error(`  Conflicting files:`);
      for (const file of result.conflictingFiles) {
        error(`    - ${file}`);
      }
    }
  }

  if (summary.failed.length > 1) {
    info(
      `\nNote: "fireforge resolve" will address the first failed patch (${firstFailed?.patch.filename}).`
    );
    info('Re-run "fireforge import" after resolving to continue with remaining patches.');
  }

  if (summary.skipped.length > 0) {
    warn(`\n${summary.skipped.length} patch(es) were skipped:`);
    for (const patch of summary.skipped) {
      warn(`  - ${patch.filename}`);
    }
    info('\nUse --continue flag to attempt all patches');
  }

  info('\nResolution Instructions:');
  if (firstFailed) {
    info(`  Patch ${firstFailed.patch.filename} failed to apply automatically.`);
  }
  info('  1. Manually fix the conflicts in the engine/ directory (look for .rej files if any).');
  info(
    '  2. Run "fireforge resolve" to update the patch file with your manual fixes and continue.'
  );

  throw new PatchError(
    `Failed to apply ${summary.failed.length} patch(es)`,
    firstFailed?.patch.filename
  );
}

async function checkEngineDrift(
  engineDir: string,
  baseCommit: string,
  forceImport: boolean
): Promise<boolean> {
  const currentHead = await getHead(engineDir);
  if (currentHead === baseCommit) return true;

  if (!process.stdin.isTTY) {
    if (!forceImport) {
      throw new GeneralError(
        'Engine HEAD has drifted from base commit. Re-run with --force to bypass drift check.'
      );
    }
    warn(
      'Engine HEAD has drifted from base commit. Continuing because --force was provided in non-interactive mode.'
    );
  } else {
    if (forceImport) {
      warn('Engine HEAD has drifted from base commit. Continuing because --force was provided.');
    } else {
      warn('Warning: Engine is not at the baseline commit.');
      const shouldContinue = await confirm({
        message:
          'Engine HEAD has drifted. Applying patches now might lead to unexpected conflicts. Continue anyway?',
        initialValue: false,
      });

      if (isCancel(shouldContinue) || !shouldContinue) {
        outro('Import cancelled by user');
        return false;
      }
    }
  }
  return true;
}

/**
 * Builds the set of patch filenames in scope when `--until <name>` is set.
 * Accepts either the full filename (e.g. `001-foo.patch`) or the name
 * without the `.patch` suffix (matching `applyPatchesWithContinue`'s
 * `untilFilename` resolver).
 *
 * Returns an empty set when no match is found — the caller treats that as
 * "no scope filter applies" so the import behaves identically to an
 * unrecognised `--until` target (which `applyPatchesWithContinue` will
 * later surface as a normal error).
 */
function buildUntilFilenameSet(
  patches: ReadonlyArray<{ filename: string; order: number }>,
  until: string | undefined
): Set<string> {
  const set = new Set<string>();
  if (until === undefined) return set;
  const normalized = until.endsWith('.patch') ? until : `${until}.patch`;
  const target = patches.find((p) => p.filename === until || p.filename === normalized);
  if (!target) return set;
  for (const patch of patches) {
    if (patch.order <= target.order) {
      set.add(patch.filename);
    }
  }
  return set;
}

/**
 * Runs the manifest consistency check, scoped to the `--until` subset:
 * global (manifest-level) issues always block, per-patch issues only
 * block when the patch is in scope. Throws GeneralError with the repair
 * hint when anything in scope is broken.
 */
async function assertScopedManifestConsistency(
  patchesDir: string,
  untilFilenameSet: Set<string>,
  until: string | undefined
): Promise<void> {
  const manifestConsistencyIssues = await validatePatchesManifestConsistency(patchesDir);
  const scopedManifestIssues =
    until !== undefined
      ? manifestConsistencyIssues.filter(
          (issue) =>
            // Global (manifest-level) issues have no specific filename to scope
            // against — a missing or unparseable patches.json blocks any
            // import. Per-patch issues only block when the patch is in scope.
            issue.code === 'manifest-missing' ||
            issue.code === 'manifest-invalid' ||
            untilFilenameSet.has(issue.filename)
        )
      : manifestConsistencyIssues;
  if (scopedManifestIssues.length > 0) {
    const issueSummary = scopedManifestIssues.map((issue) => issue.message).join('\n  ');
    throw new GeneralError(
      'Patch manifest consistency check failed. Repair patches/patches.json before importing.\n' +
        `  ${issueSummary}\n\n` +
        'Run "fireforge doctor --repair-patches-manifest" to rebuild the manifest from on-disk patch files.'
    );
  }
}

/**
 * Prints advisory version-compatibility warnings for every in-scope patch
 * whose recorded source version differs meaningfully from the configured
 * Firefox version. Advisory only — never blocks the import.
 */
async function warnVersionCompatibility(
  projectRoot: string,
  manifest: PatchesManifest | null,
  untilFilenameSet: Set<string>,
  until: string | undefined
): Promise<void> {
  if (!manifest) return;
  const config = await loadConfig(projectRoot);
  const currentVersion = config.firefox.version;

  for (const patch of manifest.patches) {
    // Scope the advisory warnings too: an operator running with --until
    // doesn't need to see version warnings for patches outside the range.
    if (until !== undefined && !untilFilenameSet.has(patch.filename)) continue;
    const warning = checkVersionCompatibility(getPatchSourceVersion(patch), currentVersion);
    if (warning) {
      warn(`${patch.filename}: ${warning}`);
    }
  }
}

/**
 * Patch-integrity gate: surfaces orphaned-modification issues scoped to
 * the `--until` range and decides whether the import may proceed —
 * `--force` continues with a warning, non-TTY refuses loudly, and an
 * interactive operator is prompted. Returns false when the import should
 * stop (the cancel outro has been printed).
 */
async function gateImportIntegrity(
  paths: ReturnType<typeof getProjectPaths>,
  untilFilenameSet: Set<string>,
  until: string | undefined,
  forceImport: boolean
): Promise<boolean> {
  const allIntegrityIssues = await validatePatchIntegrity(paths.patches, paths.engine);
  const integrityIssues =
    until !== undefined
      ? allIntegrityIssues.filter((issue) => untilFilenameSet.has(issue.filename))
      : allIntegrityIssues;
  if (integrityIssues.length > 0) {
    warn('\nPatch integrity issues detected:');
    for (const issue of integrityIssues) {
      warn(`  ${issue.filename}: ${issue.message}`);
    }
    info('Run "fireforge doctor" for more details.');

    if (forceImport) {
      warn('Continuing because --force was provided. Integrity issues were not resolved.\n');
    } else if (!process.stdin.isTTY) {
      throw new GeneralError(
        `Refusing to import while ${integrityIssues.length} patch integrity issue(s) are unresolved. ` +
          `Fix the issues reported above (see "fireforge doctor") or re-run with --force to continue anyway.`
      );
    } else {
      const shouldContinue = await confirm({
        message:
          'Patch integrity issues detected. Continuing may fail with cascading errors during patch application. Continue anyway?',
        initialValue: false,
      });
      if (isCancel(shouldContinue) || !shouldContinue) {
        outro('Import cancelled — fix the integrity issues and re-run');
        return false;
      }
    }
  }
  return true;
}

/**
 * Dry-run rendering: lists the in-scope patches (or the bare count when no
 * manifest exists) and prints the dry-run outro.
 */
function renderImportDryRun(
  manifest: PatchesManifest | null,
  untilFilenameSet: Set<string>,
  until: string | undefined,
  patchCount: number
): void {
  if (manifest) {
    const patches =
      until !== undefined
        ? manifest.patches.filter((p) => untilFilenameSet.has(p.filename))
        : manifest.patches;

    info(`\n[dry-run] Would apply ${patches.length} patch(es) in order:`);
    for (const patch of patches) {
      info(
        `  ${patch.filename} (${patch.filesAffected.length} file${patch.filesAffected.length === 1 ? '' : 's'})`
      );
    }
  } else {
    info(`\n[dry-run] Would apply ${patchCount} patch(es)`);
  }
  outro('Dry run complete — no changes made');
}

/**
 * Runs the import command to apply patches.
 * @param projectRoot - Root directory of the project
 * @param options - Import options
 */
export async function importCommand(
  projectRoot: string,
  options: ImportOptions = {}
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Import (dry run)' : 'FireForge Import');

  const continueOnFailure = options.continue ?? false;
  const forceImport = options.force ?? false;

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Engine consistency check before applying patches
  const state = await loadState(projectRoot);
  if (state.baseCommit && !isDryRun) {
    const shouldContinue = await checkEngineDrift(paths.engine, state.baseCommit, forceImport);
    if (!shouldContinue) return;
  }

  // Check if patches directory exists
  if (!(await pathExists(paths.patches))) {
    info('No patches directory found. Nothing to import.');
    outro('Import complete (no patches)');
    return;
  }

  // Count patches
  const patchCount = await countPatches(paths.patches);

  if (patchCount === 0) {
    info('No patch files found in patches/ directory.');
    outro('Import complete (no patches)');
    return;
  }

  // Load manifest early so we can scope the integrity / consistency checks to
  // the `--until` subset. The manifest-consistency check stays global because
  // structural manifest corruption (missing / duplicate rows) should block any
  // import regardless of scope, but per-patch integrity and files-affected
  // issues are legitimately skippable when the operator has asked to stop at
  // an earlier patch.
  const manifest = await loadPatchesManifest(paths.patches);
  const untilFilenameSet = buildUntilFilenameSet(manifest?.patches ?? [], options.until);

  const scopedPatchCount = options.until !== undefined ? untilFilenameSet.size : patchCount;
  info(
    `Found ${scopedPatchCount} patch${scopedPatchCount === 1 ? '' : 'es'} to apply${
      options.until !== undefined ? ` (up to ${options.until})` : ''
    }`
  );

  await assertScopedManifestConsistency(paths.patches, untilFilenameSet, options.until);

  await warnVersionCompatibility(projectRoot, manifest, untilFilenameSet, options.until);

  // Validate patch integrity (detect orphaned modification patches). Warn
  // and prompt the operator to confirm before proceeding — the legacy
  // warn-and-continue behaviour hid the real root cause because import
  // would later fail during patch application with a secondary, unrelated
  // error that made diagnosis harder.
  //
  // Scope the surfaced issues to the `--until` range: a later patch with
  // integrity problems should not block importing an earlier good subset,
  // which is exactly what operators reach for when the tail of the queue
  // is broken and they want to keep working against an earlier checkpoint.
  const integrityOk = await gateImportIntegrity(
    paths,
    untilFilenameSet,
    options.until,
    forceImport
  );
  if (!integrityOk) return;

  if (isDryRun) {
    renderImportDryRun(manifest, untilFilenameSet, options.until, patchCount);
    return;
  }

  await checkUncommittedPatchFiles(paths.engine, paths.patches, forceImport);

  const s = spinner('Applying patches...');

  try {
    const summary = await applyPatchesWithContinue(paths.patches, paths.engine, {
      continueOnFailure,
      untilFilename: options.until,
    });

    // Handle failures
    if (summary.failed.length > 0) {
      s.error(`${summary.failed.length} patch(es) failed`);
      await handlePatchFailures(summary, projectRoot);
    }

    // Count auto-resolved patches
    const autoResolved = summary.succeeded.filter((r) => r.autoResolved);
    const autoResolvedCount = autoResolved.length;

    // Build success message
    let stopMessage = `Applied ${summary.succeeded.length} patch${summary.succeeded.length === 1 ? '' : 'es'}`;
    if (autoResolvedCount > 0) {
      stopMessage += ` (${autoResolvedCount} auto-resolved)`;
    }
    s.stop(stopMessage);

    // List applied patches
    for (const result of summary.succeeded) {
      const suffix = result.autoResolved ? ' (auto-resolved)' : '';
      success(`  ${result.patch.filename}${suffix}`);
    }

    outro('All patches applied successfully!');
  } catch (error: unknown) {
    if (!(error instanceof PatchError)) {
      s.error('Patch application failed');
    }
    throw error;
  }
}

/** Registers the import command on the CLI program. */
export function registerImport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('import')
    .description('Apply patches from the patches directory')
    .option('--continue', 'Continue applying patches even if one fails')
    .option(
      '-f, --force',
      'Proceed despite engine drift and overwrite unmanaged changes in patch-touched files'
    )
    .option(
      '--until <patch>',
      'Apply patches only up to and including this patch (alias: --stop-at)'
    )
    .option('--stop-at <patch>', 'Alias for --until')
    .option('--dry-run', 'Preview which patches would be applied without modifying the engine')
    .action(
      withErrorHandling(
        async (options: {
          continue?: boolean;
          force?: boolean;
          until?: string;
          stopAt?: string;
          dryRun?: boolean;
        }) => {
          // Accept both spellings; --until wins when both are passed.
          const merged: typeof options = { ...options };
          if (merged.until === undefined && merged.stopAt !== undefined) {
            merged.until = merged.stopAt;
          }
          delete merged.stopAt;
          await importCommand(getProjectRoot(), pickDefined(merged));
        }
      )
    );
}
