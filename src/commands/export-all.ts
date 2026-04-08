// SPDX-License-Identifier: EUPL-1.2
import { Command, Option } from 'commander';

import { isBrandingManagedPath } from '../core/branding.js';
import { getProjectPaths, loadConfig } from '../core/config.js';
import { hasChanges, isGitRepository } from '../core/git.js';
import { getAllDiff } from '../core/git-diff.js';
import { getWorkingTreeStatus } from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { commitExportedPatch } from '../core/patch-export.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ExportOptions, PatchCategory } from '../types/commands/index.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  promptExportPatchMetadata,
  runPatchLint,
} from './export-shared.js';

async function checkBrandingManagedFiles(
  paths: ReturnType<typeof getProjectPaths>,
  config: Awaited<ReturnType<typeof loadConfig>>
): Promise<void> {
  const changedFiles = await getWorkingTreeStatus(paths.engine);
  const brandingManagedFiles = changedFiles
    .flatMap((entry) =>
      [entry.file, entry.originalPath].filter((value): value is string => !!value)
    )
    .filter((file) => isBrandingManagedPath(file, config.binaryName));

  if (brandingManagedFiles.length > 0) {
    throw new GeneralError(
      'Export-all refuses to capture tool-managed branding changes by default.\n\n' +
        'Review these files with "fireforge status" first. If you intentionally want a branding patch, export the specific branding paths explicitly with "fireforge export ...".'
    );
  }
}

/**
 * Runs the export-all command to export all changes as a patch.
 * @param projectRoot - Root directory of the project
 * @param options - Export options
 */
export async function exportAllCommand(
  projectRoot: string,
  options: ExportOptions = {}
): Promise<void> {
  intro('FireForge Export All');

  const paths = getProjectPaths(projectRoot);

  // Check if engine exists
  if (!(await pathExists(paths.engine))) {
    throw new GeneralError('Firefox source not found. Run "fireforge download" first.');
  }

  // Check if it's a git repository
  if (!(await isGitRepository(paths.engine))) {
    throw new GeneralError(
      'Engine directory is not a git repository. Run "fireforge download" to initialize.'
    );
  }

  // Check for changes
  if (!(await hasChanges(paths.engine))) {
    info('No changes to export');
    outro('Nothing to export');
    return;
  }

  const config = await loadConfig(projectRoot);
  await checkBrandingManagedFiles(paths, config);

  // Get the full diff
  let diff = await getAllDiff(paths.engine);

  if (!diff.trim()) {
    info('No diff content to export');
    outro('Nothing to export');
    return;
  }

  // Check for non-interactive mode
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Auto-fix missing license headers on new files (interactive only)
  const headersAdded = await autoFixLicenseHeaders(paths.engine, diff, config, isInteractive);
  if (headersAdded) {
    diff = await getAllDiff(paths.engine);
  }

  const metadata = await promptExportPatchMetadata(options, isInteractive, 'export-all');
  if (!metadata) return;
  const { patchName, selectedCategory, description } = metadata;

  // Ensure patches directory exists
  await ensureDir(paths.patches);

  const s = spinner('Exporting all changes...');

  try {
    // Extract affected files from diff
    const filesAffected = extractAffectedFiles(diff);

    await runPatchLint(paths.engine, filesAffected, diff, config, options.skipLint);

    // Check how many existing patches would be superseded
    const shouldProceed = await confirmSupersedePatches(
      paths.patches,
      filesAffected,
      options.supersede,
      isInteractive,
      s
    );
    if (!shouldProceed) return;

    // Get Firefox version for metadata
    const { patchFilename, superseded } = await commitExportedPatch({
      patchesDir: paths.patches,
      category: selectedCategory,
      name: patchName,
      description,
      diff,
      filesAffected,
      sourceEsrVersion: config.firefox.version,
    });

    for (const oldPatch of superseded) {
      info(`Superseded: ${oldPatch.filename}`);
    }

    s.stop(`Exported to ${patchFilename}`);

    info(`\nPatch saved to: patches/${patchFilename}`);
    if (filesAffected.length > 0) {
      info(`Files affected: ${filesAffected.length}`);
    }

    outro('Export complete');
  } catch (error: unknown) {
    s.error('Export failed');
    throw error;
  }
}

/** Registers the export-all command on the CLI program. */
export function registerExportAll(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('export-all')
    .description('Export all changes as a patch')
    .option('--name <name>', 'Name for the patch')
    .addOption(
      new Option('-c, --category <category>', 'Patch category').choices([...PATCH_CATEGORIES])
    )
    .option('-d, --description <desc>', 'Description of the patch')
    .option('--supersede', 'Allow superseding multiple existing patches')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .action(
      withErrorHandling(
        async (options: {
          name?: string;
          category?: string;
          description?: string;
          supersede?: boolean;
          skipLint?: boolean;
        }) => {
          const { category, ...rest } = options;
          await exportAllCommand(getProjectRoot(), {
            ...pickDefined(rest),
            ...(category !== undefined ? { category: category as PatchCategory } : {}),
          });
        }
      )
    );
}
