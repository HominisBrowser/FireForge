// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig, updateState } from '../core/config.js';
import { downloadFirefoxSource, formatBytes } from '../core/firefox.js';
import { getFurnacePaths, updateFurnaceState } from '../core/furnace-config.js';
import {
  getHead,
  initRepository,
  isGitRepository,
  isMissingHeadError,
  resumeRepository,
} from '../core/git.js';
import { restoreTrackedPath } from '../core/git-file-ops.js';
import { getDirtyFiles } from '../core/git-status.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { EngineExistsError, PartialEngineExistsError } from '../errors/download.js';
import type { CommandContext } from '../types/cli.js';
import type { DownloadOptions } from '../types/commands/index.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, ensureDir, pathExists, removeDir } from '../utils/fs.js';
import { info, intro, outro, spinner, step, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';

/**
 * Collects the set of patch-touched files from the manifest.
 * Returns an empty set when the patches directory or manifest is absent.
 */
async function getPatchTouchedFiles(patchesDir: string): Promise<Set<string>> {
  if (!(await pathExists(patchesDir))) return new Set();

  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) return new Set();

  const files = new Set<string>();
  for (const patch of manifest.patches) {
    for (const file of patch.filesAffected) {
      files.add(file);
    }
  }
  return files;
}

/**
 * Restores patch-touched files to their committed (HEAD) state so that a
 * subsequent `fireforge import` does not see spurious uncommitted changes.
 *
 * Files that were already dirty *before* the download started (tracked via
 * `preExistingDirty`) are left untouched and warned about.
 */
async function cleanPatchTouchedFiles(
  engineDir: string,
  patchesDir: string,
  preExistingDirty?: Set<string>
): Promise<void> {
  const patchFiles = await getPatchTouchedFiles(patchesDir);
  if (patchFiles.size === 0) return;

  const dirtyFiles = await getDirtyFiles(engineDir, [...patchFiles]);
  if (dirtyFiles.length === 0) return;

  const toClean = preExistingDirty
    ? dirtyFiles.filter((f) => !preExistingDirty.has(f))
    : dirtyFiles;
  const preserved = preExistingDirty ? dirtyFiles.filter((f) => preExistingDirty.has(f)) : [];

  for (const file of toClean) {
    try {
      await restoreTrackedPath(engineDir, file);
    } catch {
      warn(`Could not restore patch-touched file: ${file}`);
    }
  }

  if (toClean.length > 0) {
    info(`Restored ${toClean.length} patch-touched file(s) to baseline state.`);
  }
  if (preserved.length > 0) {
    warn(`${preserved.length} patch-touched file(s) had pre-existing changes and were left as-is:`);
    for (const file of preserved) {
      warn(`  ${file}`);
    }
  }
}

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

  // Disk space pre-flight: Firefox source is ~5 GB
  await checkDiskSpace(projectRoot, 5 * 1024 * 1024 * 1024, warn);

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

            // Snapshot patch-touched files that are already dirty so we
            // can preserve them after the resume commit.
            const patchFiles = await getPatchTouchedFiles(paths.patches);
            const preExistingDirty =
              patchFiles.size > 0
                ? new Set(await getDirtyFiles(paths.engine, [...patchFiles]))
                : new Set<string>();

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

              // Restore patch-touched files BEFORE stamping state. If this
              // step fails (disk full, permission denied, git object issue),
              // state.json keeps the previous downloadedVersion so the
              // invariant "state.downloadedVersion matches a clean engine"
              // holds. A retry of `fireforge download` then re-enters the
              // resume path instead of declaring success against a dirty
              // engine.
              await cleanPatchTouchedFiles(paths.engine, paths.patches, preExistingDirty);

              await updateState(projectRoot, {
                downloadedVersion: version,
                baseCommit,
              });

              outro(`Firefox ${version} is ready! (resumed from partial init)`);
              return;
            } catch (error: unknown) {
              resumeSpinner.error('Resume failed');
              // Preserve the underlying cause so the user sees *why* the
              // resume failed (timeout, permission denied, corrupted object,
              // disk full, …) instead of only the generic "partial engine
              // exists" story. Verbose mode prints the stack for deeper
              // triage.
              const cause = toError(error);
              verbose(`Resume failure detail: ${cause.message}`);
              if (cause.stack) {
                verbose(cause.stack);
              }
              throw new PartialEngineExistsError(paths.engine, cause);
            }
          }
          // Re-throw unexpected git errors (corrupted objects, permission
          // denied, …) wrapped in PartialEngineExistsError so the user sees
          // both narratives: "we detected a partial engine and attempted
          // resume" AND the underlying git failure. Without the wrap the
          // raw git error loses the context that resume was in flight.
          const cause = toError(error);
          verbose(`Partial-engine probe failed with unexpected error: ${cause.message}`);
          if (cause.stack) {
            verbose(cause.stack);
          }
          throw new PartialEngineExistsError(paths.engine, cause);
        }
      }

      throw new EngineExistsError(paths.engine);
    }

    warn('Removing existing engine directory...');
    await removeDir(paths.engine);

    // --force installs a new baseCommit, which invalidates every applied
    // checksum in furnace-state.json. Clearing the state now prevents a
    // subsequent `furnace apply` from reporting "up to date" against an
    // engine that no longer contains any of the deployed files. Preserve
    // pendingRepair: authoring-side rollback markers describe unresolved
    // component workspace state and should survive an engine refresh.
    const furnacePaths = getFurnacePaths(projectRoot);
    if (await pathExists(furnacePaths.furnaceState)) {
      await updateFurnaceState(projectRoot, (current) => ({
        ...(current.pendingRepair ? { pendingRepair: current.pendingRepair } : {}),
      }));
    }
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

  // Restore any patch-touched files that ended up dirty after the initial
  // commit (e.g. line-ending normalisation or extraction artefacts) so that
  // a subsequent `fireforge import` works without --force.
  //
  // This runs BEFORE updateState so a restore failure keeps the previous
  // downloadedVersion in state.json. The invariant we preserve is
  // "state.downloadedVersion matches a clean engine": stamping the new
  // version only after the restore succeeds means a failed clean-up will
  // re-enter the resume path on the next `fireforge download` rather than
  // reporting success against a dirty engine.
  await cleanPatchTouchedFiles(paths.engine, paths.patches);

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
