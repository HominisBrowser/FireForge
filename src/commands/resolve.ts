// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, saveState } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { getStagedDiffForFiles } from '../core/git-diff.js';
import { stageFiles, unstageFiles } from '../core/git-file-ops.js';
import { updatePatch, updatePatchMetadata } from '../core/patch-export.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { GeneralError, ResolutionError } from '../errors/base.js';
import type { CommandContext } from '../types/cli.js';
import { toError } from '../utils/errors.js';
import { pathExists } from '../utils/fs.js';
import {
  error as logError,
  info,
  intro,
  isCancel,
  outro,
  spinner,
  success,
} from '../utils/logger.js';

/**
 * Runs the resolve command to fix broken patches.
 * @param projectRoot - Root directory of the project
 */
export async function resolveCommand(projectRoot: string): Promise<void> {
  intro('FireForge Resolve');

  const paths = getProjectPaths(projectRoot);
  const state = await loadState(projectRoot);

  if (!state.pendingResolution) {
    info('No patch resolution currently required.');
    outro('Resolution complete');
    return;
  }

  const { patchFilename } = state.pendingResolution;
  info(`Resolving conflict for patch: ${patchFilename}`);

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

  if (!process.stdin.isTTY) {
    throw new GeneralError(
      'Cannot run "fireforge resolve" in non-interactive mode. Use a terminal with TTY support.'
    );
  }

  const finished = await confirm({
    message: 'Have you finished manually fixing the files in engine/?',
    initialValue: true,
  });

  if (isCancel(finished) || !finished) {
    info('Please fix the conflicts and run "fireforge resolve" again.');
    outro('Resolution paused');
    return;
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) {
    throw new GeneralError('Patches manifest not found.');
  }

  const patchMetadata = manifest.patches.find((p) => p.filename === patchFilename);
  if (!patchMetadata) {
    throw new ResolutionError(`Patch ${patchFilename} not found in manifest.`);
  }

  const s = spinner(`Updating ${patchFilename}...`);

  try {
    const existingFiles = patchMetadata.filesAffected;

    // Verify all affected files exist in engine/
    const missingFiles: string[] = [];
    for (const file of existingFiles) {
      const filePath = join(paths.engine, file);
      if (!(await pathExists(filePath))) {
        missingFiles.push(file);
      }
    }

    if (missingFiles.length === existingFiles.length) {
      throw new ResolutionError(`All affected files for ${patchFilename} are missing.`);
    }

    // Filter to only existing files
    const activeFiles = existingFiles.filter((f) => !missingFiles.includes(f));

    // Stage, diff, unstage
    let diffContent: string;
    let staged = false;
    try {
      await stageFiles(paths.engine, activeFiles);
      staged = true;
      diffContent = await getStagedDiffForFiles(paths.engine, activeFiles);
    } finally {
      if (staged) {
        await unstageFiles(paths.engine, activeFiles);
      }
    }

    if (!diffContent.trim()) {
      s.stop(`No patch update generated for ${patchFilename}`);
      info(
        'No patch update was generated from the staged diff. Pending resolution was left intact so you can retry. To discard the resolution state, delete the "pendingResolution" key from state.json.'
      );
      outro('Resolution unchanged');
      return;
    }

    // Write the new diff content to the patch file
    const patchPath = join(paths.patches, patchFilename);
    await updatePatch(patchPath, diffContent);

    // Update metadata (preserve original createdAt)
    const config = await loadConfig(projectRoot);
    await updatePatchMetadata(paths.patches, patchFilename, {
      ...(activeFiles.length < existingFiles.length ? { filesAffected: activeFiles } : {}),
      sourceEsrVersion: config.firefox.version,
    });

    // Cleanup: Clear pendingResolution from state.json
    delete state.pendingResolution;
    await saveState(projectRoot, state);

    s.stop(`Updated ${patchFilename}`);
    success('Patch updated successfully and resolution state cleared.');
    info('Run "fireforge import" to apply the remaining patches.');
    outro('Resolution complete');
  } catch (error: unknown) {
    s.error(`Resolution failed for ${patchFilename}`);
    logError(toError(error).message);
    throw error;
  }
}

/** Registers the resolve command on the CLI program. */
export function registerResolve(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('resolve')
    .description('Update a broken patch with manual fixes and continue')
    .action(
      withErrorHandling(async () => {
        await resolveCommand(getProjectRoot());
      })
    );
}
