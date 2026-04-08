// SPDX-License-Identifier: EUPL-1.2
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Command, Option } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { getStatusWithCodes, isGitRepository } from '../core/git.js';
import { generateBinaryFilePatch, generateFullFilePatch } from '../core/git-diff.js';
import { isBinaryFile } from '../core/git-file-ops.js';
import {
  getModifiedFilesInDir,
  getUntrackedFiles,
  getUntrackedFilesInDir,
} from '../core/git-status.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { commitExportedPatch } from '../core/patch-export.js';
import { GeneralError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { ExportOptions, PatchCategory } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { ensureDir, pathExists } from '../utils/fs.js';
import { info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { PATCH_CATEGORIES } from '../utils/validation.js';
import {
  autoFixLicenseHeaders,
  confirmSupersedePatches,
  promptExportPatchMetadata,
  runPatchLint,
} from './export-shared.js';

async function collectExportFiles(
  paths: ReturnType<typeof getProjectPaths>,
  files: string[]
): Promise<string[]> {
  const collectedFiles = new Set<string>();

  let fileStatuses: { status: string; file: string }[] | undefined;
  let untrackedFiles: string[] | undefined;

  for (const inputPath of files) {
    const fullInputPath = join(paths.engine, inputPath);
    let isDirectory = false;
    try {
      const fileStat = await stat(fullInputPath);
      isDirectory = fileStat.isDirectory();
    } catch (error: unknown) {
      verbose(
        `Treating ${inputPath} as a file because directory stat failed: ${toError(error).message}`
      );
    }

    if (isDirectory) {
      const dirPath = inputPath.endsWith('/') ? inputPath.slice(0, -1) : inputPath;
      const modifiedFiles = await getModifiedFilesInDir(paths.engine, dirPath);
      const dirUntrackedFiles = await getUntrackedFilesInDir(paths.engine, dirPath);
      for (const f of modifiedFiles) collectedFiles.add(f);
      for (const f of dirUntrackedFiles) collectedFiles.add(f);
    } else {
      if (inputPath.endsWith('/')) {
        throw new GeneralError(`"${inputPath}" is not a valid file or directory.`);
      }

      if (!fileStatuses) {
        fileStatuses = await getStatusWithCodes(paths.engine);
      }
      const fileStatus = fileStatuses.find((s) => s.file === inputPath);

      if (!fileStatus) {
        if (!untrackedFiles) {
          untrackedFiles = await getUntrackedFiles(paths.engine);
        }
        if (!untrackedFiles.includes(inputPath)) {
          throw new GeneralError(
            `File "${inputPath}" has no changes to export.\n\n` +
              'Run "fireforge status" to see modified files.'
          );
        }
      }

      collectedFiles.add(inputPath);
    }
  }

  return [...collectedFiles].sort();
}

async function generatePatchDiff(engineDir: string, allFiles: string[]): Promise<string> {
  const diffs: string[] = [];

  for (const file of allFiles) {
    const fullPath = join(engineDir, file);
    const isExistingBinary = (await pathExists(fullPath)) && (await isBinaryFile(engineDir, file));
    const diff = isExistingBinary
      ? await generateBinaryFilePatch(engineDir, file)
      : await generateFullFilePatch(engineDir, file);

    if (isExistingBinary) {
      if (diff.trim()) {
        info(`Including binary file: ${file}`);
      } else {
        warn(`Skipping binary file with no diff: ${file}`);
      }
    }

    if (diff.trim()) {
      diffs.push(diff);
    }
  }

  return diffs.join('\n');
}

/**
 * Runs the export command to export file changes as a patch.
 * Accepts one or more file/directory paths and bundles them into a single patch.
 * @param projectRoot - Root directory of the project
 * @param files - File or directory paths to export (relative to engine/)
 * @param options - Export options
 */
export async function exportCommand(
  projectRoot: string,
  files: string[],
  options: ExportOptions
): Promise<void> {
  intro('FireForge Export');

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

  const allFiles = await collectExportFiles(paths, files);

  if (allFiles.length === 0) {
    const pathList = files.join(', ');
    throw new GeneralError(
      `Paths "${pathList}" have no changes to export.\n\n` +
        'Run "fireforge status" to see modified files.'
    );
  }

  let diff = await generatePatchDiff(paths.engine, allFiles);

  if (!diff.trim()) {
    throw new GeneralError('The specified paths have no diff content to export.');
  }

  // Ensure patches directory exists
  await ensureDir(paths.patches);

  const config = await loadConfig(projectRoot);
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  // Auto-fix missing license headers on new files (interactive only)
  const headersAdded = await autoFixLicenseHeaders(paths.engine, diff, config, isInteractive);
  if (headersAdded) {
    diff = await generatePatchDiff(paths.engine, allFiles);
  }

  const metadata = await promptExportPatchMetadata(options, isInteractive, 'export');
  if (!metadata) return;
  const { patchName, selectedCategory, description } = metadata;

  const s = spinner('Exporting patch...');

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
      info(`Files affected: ${filesAffected.join(', ')}`);
    }
    outro('Export complete');
  } catch (error: unknown) {
    s.error('Export failed');
    throw error;
  }
}

/** Registers the export command on the CLI program. */
export function registerExport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('export <paths...>')
    .description('Export new changes as a patch (use re-export to update existing patches)')
    .option('-n, --name <name>', 'Name for the patch')
    .addOption(
      new Option('-c, --category <category>', 'Patch category').choices([...PATCH_CATEGORIES])
    )
    .option('-d, --description <desc>', 'Description of the patch')
    .option('--supersede', 'Allow superseding multiple existing patches')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .action(
      withErrorHandling(
        async (
          paths: string[],
          options: {
            name?: string;
            category?: string;
            description?: string;
            supersede?: boolean;
            skipLint?: boolean;
          }
        ) => {
          const { category, ...rest } = options;
          await exportCommand(getProjectRoot(), paths, {
            ...pickDefined(rest),
            ...(category !== undefined ? { category: category as PatchCategory } : {}),
          });
        }
      )
    );
}
