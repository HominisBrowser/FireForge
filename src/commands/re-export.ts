// SPDX-License-Identifier: EUPL-1.2
import { dirname, join } from 'node:path';

import { multiselect } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { getDiffForFilesAgainstHead } from '../core/git-diff.js';
import { getModifiedFilesInDir, getUntrackedFilesInDir } from '../core/git-status.js';
import { updatePatch, updatePatchMetadata } from '../core/patch-export.js';
import { lintExportedPatch } from '../core/patch-lint.js';
import { getClaimedFiles, loadPatchesManifest } from '../core/patch-manifest.js';
import { GeneralError, InvalidArgumentError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import type { PatchesManifest, PatchMetadata, ReExportOptions } from '../types/commands/index.js';
import type { FireForgeConfig } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import { cancel, info, intro, isCancel, outro, spinner, success, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Resolves patch identifiers (numbers or filenames) to manifest entries.
 * @param identifier - Patch number (e.g. "005") or filename (e.g. "005-ui-storage-modules.patch")
 * @param patches - All patches from the manifest
 * @returns Matching patch metadata
 */
function resolvePatchIdentifier(
  identifier: string,
  patches: PatchMetadata[]
): PatchMetadata | null {
  // If all digits, match by order number
  if (/^\d+$/.test(identifier)) {
    const order = parseInt(identifier, 10);
    return patches.find((p) => p.order === order) ?? null;
  }

  // Match by filename (with or without .patch suffix)
  const normalized = identifier.endsWith('.patch') ? identifier : `${identifier}.patch`;
  return patches.find((p) => p.filename === normalized) ?? null;
}

async function scanPatchFiles(
  currentFilesAffected: string[],
  engineDir: string,
  manifest: PatchesManifest,
  patchFilename: string,
  isDryRun: boolean
): Promise<string[]> {
  const parentDirs = [...new Set(currentFilesAffected.map((f) => dirname(f)))];
  const claimedByOthers = getClaimedFiles(manifest, patchFilename);

  const discoveredFiles = new Set<string>();
  for (const dir of parentDirs) {
    const modifiedFiles = await getModifiedFilesInDir(engineDir, dir);
    const untrackedFiles = await getUntrackedFilesInDir(engineDir, dir);
    for (const f of [...modifiedFiles, ...untrackedFiles]) {
      discoveredFiles.add(f);
    }
  }

  const currentSet = new Set(currentFilesAffected);
  const added: string[] = [];
  for (const f of discoveredFiles) {
    if (!currentSet.has(f) && !claimedByOthers.has(f)) {
      added.push(f);
    }
  }

  const removed: string[] = [];
  for (const f of currentFilesAffected) {
    const filePath = join(engineDir, f);
    if (!(await pathExists(filePath))) {
      removed.push(f);
    }
  }

  for (const f of added.sort()) {
    info(`  + ${f}`);
  }
  for (const f of removed.sort()) {
    info(`  - ${f}`);
  }

  if (added.length > 0 || removed.length > 0) {
    const removedSet = new Set(removed);
    const updated = [...currentFilesAffected.filter((f) => !removedSet.has(f)), ...added].sort();

    info(
      `  ${isDryRun ? 'Would update' : 'Updated'} ${patchFilename}: +${added.length} / -${removed.length} files`
    );
    return updated;
  }

  return currentFilesAffected;
}

async function reExportSinglePatch(
  patch: PatchMetadata,
  paths: ReturnType<typeof getProjectPaths>,
  manifest: PatchesManifest,
  options: ReExportOptions,
  isDryRun: boolean,
  config: FireForgeConfig
): Promise<boolean> {
  let currentFilesAffected = [...patch.filesAffected];

  // --- Scan for new/removed files ---
  if (options.scan) {
    currentFilesAffected = await scanPatchFiles(
      currentFilesAffected,
      paths.engine,
      manifest,
      patch.filename,
      isDryRun
    );
  }

  const missingFiles: string[] = [];
  for (const file of currentFilesAffected) {
    const filePath = join(paths.engine, file);
    if (!(await pathExists(filePath))) {
      missingFiles.push(file);
    }
  }

  if (missingFiles.length === currentFilesAffected.length) {
    warn(`Skipped ${patch.filename}: all affected files missing`);
    warn(`Missing files: ${missingFiles.join(', ')}`);
    return false;
  }

  if (missingFiles.length > 0) {
    warn(`${patch.filename}: missing files will be skipped: ${missingFiles.join(', ')}`);
  }

  const missingSet = new Set(missingFiles);
  const existingFiles = currentFilesAffected.filter((f) => !missingSet.has(f));

  const diffContent = await getDiffForFilesAgainstHead(paths.engine, existingFiles);

  if (!diffContent.trim()) {
    warn(`Skipped ${patch.filename}: no changes (files unchanged from HEAD)`);
    return false;
  }

  if (isDryRun) {
    info(`[dry-run] ${patch.filename}: ${existingFiles.length} file(s)`);
  } else {
    const patchPath = join(paths.patches, patch.filename);
    await updatePatch(patchPath, diffContent);

    await updatePatchMetadata(paths.patches, patch.filename, {
      filesAffected: currentFilesAffected,
    });

    const patchIndex = manifest.patches.findIndex((pm) => pm.filename === patch.filename);
    if (patchIndex !== -1) {
      const existingEntry = manifest.patches[patchIndex];
      if (existingEntry) {
        manifest.patches[patchIndex] = {
          ...existingEntry,
          filesAffected: currentFilesAffected,
        };
      }
    }

    const lintIssues = await lintExportedPatch(paths.engine, existingFiles, diffContent, config);
    for (const issue of lintIssues) {
      const prefix = issue.severity === 'error' && !options.skipLint ? 'ERROR ' : '';
      warn(`${prefix}[${issue.check}] ${issue.file}: ${issue.message}`);
    }
    const lintErrors = lintIssues.filter((i) => i.severity === 'error');
    if (lintErrors.length > 0 && !options.skipLint) {
      warn(`${patch.filename}: ${lintErrors.length} lint error(s). Use --skip-lint to bypass.`);
    }

    success(`Re-exported ${patch.filename}`);
  }
  return true;
}

async function resolveSelectedPatches(
  patches: string[],
  options: ReExportOptions,
  manifest: PatchesManifest
): Promise<PatchMetadata[] | null> {
  if (options.all) {
    return [...manifest.patches];
  }

  if (patches.length > 0) {
    const selectedPatches: PatchMetadata[] = [];
    for (const identifier of patches) {
      const match = resolvePatchIdentifier(identifier, manifest.patches);
      if (!match) {
        const available = manifest.patches.map((p) => p.filename).join(', ');
        throw new InvalidArgumentError(
          `Patch "${identifier}" not found in manifest.\n\nAvailable patches: ${available}`,
          identifier
        );
      }
      selectedPatches.push(match);
    }
    return selectedPatches;
  }

  // No patches specified — prompt or error
  const isInteractive = process.stdin.isTTY && process.stdout.isTTY;

  if (!isInteractive) {
    throw new InvalidArgumentError(
      'Specify patch identifiers or use --all in non-interactive mode.\n\n' +
        'Usage: fireforge re-export [patches...] or fireforge re-export --all',
      'patches'
    );
  }

  const selected = await multiselect({
    message: 'Select patches to re-export:',
    options: manifest.patches.map((patch) => ({
      value: patch.filename,
      label: `${patch.filename} — ${patch.description || patch.name}`,
    })),
  });

  if (isCancel(selected)) {
    cancel('Re-export cancelled');
    return null;
  }

  const selectedFilenames = selected as string[];
  return manifest.patches.filter((p) => selectedFilenames.includes(p.filename));
}

/**
 * Runs the re-export command to regenerate existing patches from current engine state.
 * @param projectRoot - Root directory of the project
 * @param patches - Patch identifiers (numbers or filenames)
 * @param options - Re-export options
 */
export async function reExportCommand(
  projectRoot: string,
  patches: string[],
  options: ReExportOptions
): Promise<void> {
  const isDryRun = options.dryRun === true;
  intro(isDryRun ? 'FireForge Re-export (dry run)' : 'FireForge Re-export');

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

  // Load the manifest
  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError(
      'No patches found in manifest. Run "fireforge export" to create patches first.'
    );
  }

  // Resolve which patches to re-export
  const selectedPatches = await resolveSelectedPatches(patches, options, manifest);
  if (!selectedPatches) return;

  if (selectedPatches.length === 0) {
    warn('No patches selected');
    outro('Nothing to re-export');
    return;
  }

  const config = await loadConfig(projectRoot);

  let reExported = 0;
  const progress = spinner('Preparing re-export...');

  for (const patch of selectedPatches) {
    progress.message(`Re-exporting ${patch.filename}...`);
    try {
      const exported = await reExportSinglePatch(patch, paths, manifest, options, isDryRun, config);
      if (exported) reExported++;
    } catch (error: unknown) {
      warn(`Failed to re-export ${patch.filename}`);
      warn(toError(error).message);
    }
  }

  if (reExported === 0 && selectedPatches.length > 0) {
    progress.error('Re-export failed');
    throw new GeneralError('All selected patches failed to re-export. Check the errors above.');
  }

  if (isDryRun) {
    progress.stop('Dry run complete');
    success(`[dry-run] Would re-export ${reExported} of ${selectedPatches.length} patch(es)`);
    outro('Dry run complete');
  } else {
    progress.stop('Re-export complete');
    success(`Re-exported ${reExported} of ${selectedPatches.length} patch(es)`);
    outro('Re-export complete');
  }
}

/** Registers the re-export command on the CLI program. */
export function registerReExport(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('re-export [patches...]')
    .description('Re-export existing patches from current engine state')
    .option('-a, --all', 'Re-export all patches')
    .option('-s, --scan', 'Scan directories for new/removed files and update filesAffected')
    .option('--dry-run', 'Show what would change without writing')
    .option('--skip-lint', 'Skip patch lint checks (downgrade errors to warnings)')
    .action(
      withErrorHandling(
        async (
          patches: string[],
          options: { all?: boolean; scan?: boolean; dryRun?: boolean; skipLint?: boolean }
        ) => {
          await reExportCommand(getProjectRoot(), patches, pickDefined(options));
        }
      )
    );
}
