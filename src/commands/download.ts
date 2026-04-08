// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig, updateState } from '../core/config.js';
import { downloadFirefoxSource, formatBytes } from '../core/firefox.js';
import {
  getHead,
  initRepository,
  isGitRepository,
  isMissingHeadError,
  resumeRepository,
} from '../core/git.js';
import { EngineExistsError, PartialEngineExistsError } from '../errors/download.js';
import type { CommandContext } from '../types/cli.js';
import type { DownloadOptions } from '../types/commands/index.js';
import { ensureDir, pathExists, removeDir } from '../utils/fs.js';
import { info, intro, outro, spinner, step, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Runs the download command.
 * @param projectRoot - Root directory of the project
 * @param options - Download options
 */
export async function downloadCommand(
  projectRoot: string,
  options: DownloadOptions
): Promise<void> {
  intro('FireForge Download');

  // Load configuration
  const config = await loadConfig(projectRoot);
  const paths = getProjectPaths(projectRoot);
  const version = config.firefox.version;

  info(`Firefox version: ${version}`);

  // Check if engine already exists
  if (await pathExists(paths.engine)) {
    if (!options.force) {
      if (await isGitRepository(paths.engine)) {
        try {
          await getHead(paths.engine);
        } catch (error: unknown) {
          if (isMissingHeadError(error)) {
            // Partial init detected — attempt to resume instead of requiring --force
            info('Detected partially initialized engine. Attempting to resume...');
            const resumeSpinner = spinner('Resuming git repository initialization...');
            try {
              await resumeRepository(paths.engine, {
                onProgress: (message) => {
                  resumeSpinner.message(message);
                  if (!(process.stdout.isTTY && process.stderr.isTTY)) {
                    step(message);
                  }
                },
              });
              const baseCommit = await getHead(paths.engine);
              resumeSpinner.stop('Git repository resumed successfully');

              await updateState(projectRoot, {
                downloadedVersion: version,
                baseCommit,
              });

              outro(`Firefox ${version} is ready! (resumed from partial init)`);
              return;
            } catch (error: unknown) {
              void error;
              resumeSpinner.error('Resume failed');
              throw new PartialEngineExistsError(paths.engine);
            }
          }
          // Re-throw unexpected git errors (e.g. corrupted objects) rather
          // than masking them behind the generic EngineExistsError below.
          throw error;
        }
      }

      throw new EngineExistsError(paths.engine);
    }

    warn('Removing existing engine directory...');
    await removeDir(paths.engine);
  }

  // Ensure cache directory exists
  const cacheDir = join(paths.fireforgeDir, 'cache');
  await ensureDir(cacheDir);

  // Download with progress
  const s = spinner(`Downloading Firefox ${version}...`);
  let lastPercent = 0;

  try {
    await downloadFirefoxSource(
      version,
      config.firefox.product,
      paths.engine,
      cacheDir,
      (downloaded, total) => {
        if (total <= 0) return;
        const percent = Math.floor((downloaded / total) * 100);
        if (percent !== lastPercent && percent % 5 === 0) {
          s.message(
            `Downloading Firefox ${version}... ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
          );
          lastPercent = percent;
        }
      }
    );

    s.stop(`Firefox ${version} downloaded`);
  } catch (error: unknown) {
    s.error('Download failed');
    throw error;
  }

  // Initialize git repository
  const gitSpinner = spinner('Initializing git repository (this may take a few minutes)...');
  let baseCommit: string | undefined;

  try {
    await initRepository(paths.engine, 'firefox', {
      onProgress: (message) => {
        gitSpinner.message(message);
        if (!(process.stdout.isTTY && process.stderr.isTTY)) {
          step(message);
        }
      },
    });
    baseCommit = await getHead(paths.engine);
    gitSpinner.stop('Git repository initialized');
  } catch (error: unknown) {
    gitSpinner.error('Failed to initialize git repository');
    warn(
      'engine/ may now contain a partially initialized git repository. Re-run "fireforge download --force" to recreate the baseline cleanly.'
    );
    throw error;
  }

  // Update state
  await updateState(projectRoot, {
    downloadedVersion: version,
    baseCommit,
  });

  outro(`Firefox ${version} is ready!`);
}

/** Registers the download command on the CLI program. */
export function registerDownload(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('download')
    .description('Download Firefox source')
    .option('-f, --force', 'Force re-download, removing existing source')
    .action(
      withErrorHandling(async (options: { force?: boolean }) => {
        await downloadCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
