// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, saveState } from '../core/config.js';
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
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ImportOptions } from '../types/commands/index.js';
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
        verbose(
          `Treating ${file} as unmanaged because patched-content classification failed: ${toError(error).message}`
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
        info('Patch-backed materialized files already match the stored patch stack.');
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
  state: Awaited<ReturnType<typeof loadState>>,
  projectRoot: string
): Promise<void> {
  const firstFailed = summary.failed[0];

  if (firstFailed) {
    state.pendingResolution = {
      patchFilename: firstFailed.patch.filename,
      originalError: firstFailed.error ?? 'Unknown error',
    };
    await saveState(projectRoot, state);
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
 * Runs the import command to apply patches.
 * @param projectRoot - Root directory of the project
 * @param options - Import options
 */
export async function importCommand(
  projectRoot: string,
  options: ImportOptions = {}
): Promise<void> {
  intro('FireForge Import');

  const continueOnFailure = options.continue ?? false;
  const forceImport = options.force ?? false;

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Engine consistency check before applying patches
  const state = await loadState(projectRoot);
  if (state.baseCommit) {
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

  info(`Found ${patchCount} patch${patchCount === 1 ? '' : 'es'} to apply`);

  const manifestConsistencyIssues = await validatePatchesManifestConsistency(paths.patches);
  if (manifestConsistencyIssues.length > 0) {
    const issueSummary = manifestConsistencyIssues.map((issue) => issue.message).join('\n  ');
    throw new GeneralError(
      'Patch manifest consistency check failed. Repair patches/patches.json before importing.\n' +
        `  ${issueSummary}\n\n` +
        'Run "fireforge doctor --repair-patches-manifest" to rebuild the manifest from on-disk patch files.'
    );
  }

  // Load manifest and check version compatibility
  const manifest = await loadPatchesManifest(paths.patches);
  if (manifest) {
    const config = await loadConfig(projectRoot);
    const currentVersion = config.firefox.version;

    for (const patch of manifest.patches) {
      const warning = checkVersionCompatibility(patch.sourceEsrVersion, currentVersion);
      if (warning) {
        warn(`${patch.filename}: ${warning}`);
      }
    }
  }

  // Validate patch integrity (detect orphaned modification patches)
  const integrityIssues = await validatePatchIntegrity(paths.patches, paths.engine);
  if (integrityIssues.length > 0) {
    warn('\nPatch integrity issues detected:');
    for (const issue of integrityIssues) {
      warn(`  ${issue.filename}: ${issue.message}`);
    }
    info('Run "fireforge doctor" for more details.\n');
  }

  await checkUncommittedPatchFiles(paths.engine, paths.patches, forceImport);

  const s = spinner('Applying patches...');

  try {
    const summary = await applyPatchesWithContinue(paths.patches, paths.engine, continueOnFailure);

    // Handle failures
    if (summary.failed.length > 0) {
      s.error(`${summary.failed.length} patch(es) failed`);
      await handlePatchFailures(summary, state, projectRoot);
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
    .action(
      withErrorHandling(async (options: { continue?: boolean; force?: boolean }) => {
        await importCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
