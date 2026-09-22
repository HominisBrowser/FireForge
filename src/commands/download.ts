// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, updateState } from '../core/config.js';
import { withFileLock } from '../core/file-lock.js';
import {
  downloadFirefoxSource,
  formatBytes,
  sweepOrphanedEngineWorkDirs,
} from '../core/firefox.js';
import { clearAppliedFurnaceState } from '../core/furnace-config.js';
import {
  getHead,
  initRepository,
  isGitRepository,
  isMissingHeadError,
  resumeRepository,
} from '../core/git.js';
import { restoreTrackedPath } from '../core/git-file-ops.js';
import { getDirtyFiles, getWorkingTreeStatus } from '../core/git-status.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { formatMajorVersionHopNotice } from '../core/toolchain-preflight.js';
import { EngineExistsError, PartialEngineExistsError } from '../errors/download.js';
import type { CommandContext } from '../types/cli.js';
import type { DownloadOptions } from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, ensureDir, pathExists, pathExistsStrict, removeDir } from '../utils/fs.js';
import type { SpinnerHandle } from '../utils/logger.js';
import { info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
import { pickDefined } from '../utils/options.js';
import { confirmDirtyEngineReset } from './rebase/confirm.js';

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
 * Describes what a forced replacement would discard from an existing
 * engine: changed paths against HEAD (tracked edits, applied patches, new
 * untracked files; ignored paths such as the objdir are not work), and a
 * HEAD that moved off the recorded base commit. Returns `undefined` when
 * nothing would be lost, including an engine that is not a git repository
 * or has no commit yet: that is the broken tree `--force` exists to replace.
 */
async function describeForcedReplacementLoss(
  engineDir: string,
  patchesDir: string,
  baseCommit: string | undefined
): Promise<string | undefined> {
  if (!(await isGitRepository(engineDir))) return undefined;
  let head: string;
  try {
    head = await getHead(engineDir);
  } catch (error: unknown) {
    if (isMissingHeadError(error)) return undefined;
    throw error;
  }

  const entries = await getWorkingTreeStatus(engineDir);
  const headMoved = baseCommit !== undefined && head !== baseCommit;
  if (entries.length === 0 && !headMoved) return undefined;

  const parts: string[] = [];
  if (entries.length > 0) {
    const patchFiles = [...(await getPatchTouchedFiles(patchesDir))];
    const claimed = entries.filter((entry) =>
      entry.file.endsWith('/')
        ? patchFiles.some((file) => file.startsWith(entry.file))
        : patchFiles.includes(entry.file)
    ).length;
    const unclaimed = entries.length - claimed;
    parts.push(
      `engine/ has ${entries.length} changed path(s) against HEAD: ` +
        `${claimed} match the patch queue, ${unclaimed} do not` +
        (unclaimed > 0 ? ' (unexported work that exists nowhere else).' : '.')
    );
  }
  if (headMoved) {
    parts.push(
      `engine/ HEAD ${head.slice(0, 12)} is not the recorded base commit ${baseCommit.slice(0, 12)}, so commits made in engine/ are discarded too.`
    );
  }
  parts.push('--force replaces the whole directory.');
  return parts.join(' ');
}

/**
 * Outcome of {@link cleanPatchTouchedFiles}. `restored` is the number of
 * dirty patch-touched files that were reset to HEAD. `preserved` is the
 * number that were dirty before the download started and were left alone.
 * A `hadQueue: false` result means the project has no patches, so callers
 * can use that to avoid printing "Patch-touched files restored" on a
 * workspace that has never exported a patch.
 */
interface CleanPatchResult {
  hadQueue: boolean;
  restored: number;
  preserved: number;
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
): Promise<CleanPatchResult> {
  const patchFiles = await getPatchTouchedFiles(patchesDir);
  if (patchFiles.size === 0) {
    return { hadQueue: false, restored: 0, preserved: 0 };
  }

  const dirtyFiles = await getDirtyFiles(engineDir, [...patchFiles]);
  if (dirtyFiles.length === 0) {
    return { hadQueue: true, restored: 0, preserved: 0 };
  }

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

  return { hadQueue: true, restored: toClean.length, preserved: preserved.length };
}

/**
 * Prints a one-line nudge pointing at `fireforge import` when the project
 * carries a non-empty patch queue but the just-downloaded engine has not yet
 * had any patches applied. The post-download spinner closes with
 * "Patch-touched files already match baseline" because a fresh tree is at
 * baseline, which reads as "patches are restored" and invites skipping the
 * import step. Suppressed when patches/ is missing or the manifest is empty
 * so unconfigured projects stay quiet.
 */
async function noteUnappliedPatches(patchesDir: string): Promise<void> {
  if (!(await pathExists(patchesDir))) return;
  const manifest = await loadPatchesManifest(patchesDir);
  if (!manifest || manifest.patches.length === 0) return;
  const n = manifest.patches.length;
  info(
    `Note: ${n} patch${n === 1 ? '' : 'es'} in patches/ have not been applied to this fresh engine. Run "fireforge import" to apply them.`
  );
}

/**
 * Stops `restoreSpinner` with a message that reflects what actually
 * happened. Three branches. An empty queue gives an explicit no-op. A queue
 * that is present but has nothing dirty gives "already clean". A queue with
 * dirty files gives the usual "Patch-touched files restored" success line.
 * Always closing with the third claims restore work that did not happen on a
 * project with zero patches.
 */
function closeRestoreSpinner(restoreSpinner: SpinnerHandle, result: CleanPatchResult): void {
  if (!result.hadQueue) {
    restoreSpinner.stop('No patches in queue — nothing to restore');
    return;
  }
  if (result.restored === 0 && result.preserved === 0) {
    restoreSpinner.stop('Patch-touched files already match baseline');
    return;
  }
  restoreSpinner.stop('Patch-touched files restored');
}

async function activateReplacementEngine(args: {
  engineDir: string;
  replacementDir: string;
  backupDir: string;
}): Promise<void> {
  const { engineDir, replacementDir, backupDir } = args;
  await rename(engineDir, backupDir);
  try {
    await rename(replacementDir, engineDir);
  } catch (error: unknown) {
    try {
      await rename(backupDir, engineDir);
    } catch (restoreError: unknown) {
      const cause = toError(restoreError);
      warn(
        `Could not restore previous engine after replacement activation failed. Previous engine backup remains at ${backupDir}. Remove ${engineDir} if it exists, then move the backup back to engine/.`
      );
      verbose(`Engine restore failure detail: ${cause.message}`);
      if (cause.stack) {
        verbose(cause.stack);
      }
    }
    throw error;
  }
}

async function restorePreviousEngine(args: {
  engineDir: string;
  backupDir: string;
  reason: unknown;
}): Promise<void> {
  const { engineDir, backupDir, reason } = args;
  const cause = toError(reason);
  verbose(`Restoring previous engine after failed forced download: ${cause.message}`);
  try {
    await removeDir(engineDir);
    await rename(backupDir, engineDir);
    warn('Restored the previous engine/ after the forced replacement failed.');
  } catch (restoreError: unknown) {
    const restoreCause = toError(restoreError);
    warn(
      `Could not restore the previous engine automatically. Previous engine backup remains at ${backupDir}. Remove the failed engine/ and move that backup back to engine/ before retrying.`
    );
    verbose(`Engine restore failure detail: ${restoreCause.message}`);
    if (restoreCause.stack) {
      verbose(restoreCause.stack);
    }
  }
}

async function downloadAndExtractFirefox(args: {
  version: string;
  product: FirefoxProduct;
  engineDir: string;
  cacheDir: string;
  sha256?: string;
  candidate?: string;
  allowUnverifiedDownload?: boolean;
}): Promise<void> {
  const { version, product, engineDir, cacheDir, sha256, candidate, allowUnverifiedDownload } =
    args;
  let s = spinner(`Downloading Firefox ${version}...`);
  let lastPercent = 0;
  const phaseState: { value: 'download' | 'extract' } = { value: 'download' };

  try {
    await downloadFirefoxSource({
      version: version,
      product: product,
      destDir: engineDir,
      cacheDir: cacheDir,
      onProgress: (downloaded, total) => {
        if (total <= 0) return;
        const percent = Math.floor((downloaded / total) * 100);
        if (percent !== lastPercent && percent % 5 === 0) {
          s.message(
            `Downloading Firefox ${version}... ${percent}% (${formatBytes(downloaded)} / ${formatBytes(total)})`
          );
          lastPercent = percent;
        }
      },
      onPhase: (phase) => {
        if (phase === 'extract' && phaseState.value === 'download') {
          s.stop(`Firefox ${version} downloaded`);
          phaseState.value = 'extract';
          s = spinner(
            `Extracting Firefox ${version}... (decompressing ~600 MB of source; typically 30–90s)`
          );
        }
      },
      expectedSha256: sha256,
      onPhaseProgress: (message) => {
        s.message(message);
      },
      candidate: candidate,
      integrity: allowUnverifiedDownload === undefined ? undefined : { allowUnverifiedDownload },
    });

    s.stop(
      phaseState.value === 'extract'
        ? `Firefox ${version} extracted`
        : `Firefox ${version} downloaded`
    );
  } catch (error: unknown) {
    s.error(phaseState.value === 'extract' ? 'Extraction failed' : 'Download failed');
    throw error;
  }
}

/**
 * Prints the major-version-hop toolchain nudge when this download moved the
 * engine across a Firefox major version. The first post-hop build otherwise
 * dies in `mach configure` on a moved cbindgen minimum with nothing in the
 * download output suggesting `fireforge bootstrap`. Quiet on first downloads
 * and same-major re-downloads.
 */
function noteMajorVersionHop(previousVersion: string | undefined, version: string): void {
  const hopNotice = formatMajorVersionHopNotice(previousVersion, version);
  if (hopNotice) {
    info(hopNotice);
  }
}

async function initializeDownloadedEngine(args: {
  projectRoot: string;
  patchesDir: string;
  version: string;
  previousVersion: string | undefined;
  engineDir: string;
  replacementActivated: boolean;
  backupEngineDir?: string;
}): Promise<void> {
  const {
    projectRoot,
    patchesDir,
    version,
    previousVersion,
    engineDir,
    replacementActivated,
    backupEngineDir,
  } = args;

  // The git indexing phase of `download` can block for minutes on a ~600 MB
  // Firefox tree. Emit a one-line heads-up banner before the spinner starts
  // so CI logs show the expected duration.
  try {
    info(
      'Indexing downloaded source into git (one-time; typically 3–5 minutes on a ~600 MB Firefox tree)...'
    );

    info('Git phase: initializing/resetting source repository metadata.');
    const gitSpinner = spinner('Initializing git repository (this may take a few minutes)...');
    let baseCommit: string | undefined;

    try {
      await initRepository(engineDir, 'firefox', {
        onProgress: (message) => {
          gitSpinner.message(message);
        },
      });
      baseCommit = await getHead(engineDir);
      gitSpinner.stop('Git repository initialized');
    } catch (error: unknown) {
      gitSpinner.error('Failed to initialize git repository');
      warn(
        replacementActivated
          ? 'Replacement engine/ failed during baseline git initialization. FireForge will try to restore the previous engine.'
          : 'engine/ may now contain a partially initialized git repository. Re-run "fireforge download --force" to recreate the baseline cleanly.'
      );
      throw error;
    }

    const restoreSpinner = spinner('Restoring patch-touched files to baseline...');
    try {
      const restoreResult = await cleanPatchTouchedFiles(engineDir, patchesDir);
      closeRestoreSpinner(restoreSpinner, restoreResult);
    } catch (error: unknown) {
      restoreSpinner.error('Failed to restore patch-touched files');
      throw error;
    }

    if (replacementActivated) {
      // --force installs a new baseCommit, which invalidates every applied
      // checksum in furnace-state.json.
      await clearAppliedFurnaceState(projectRoot);
    }

    await updateState(projectRoot, {
      downloadedVersion: version,
      baseCommit,
    });

    await noteUnappliedPatches(patchesDir);
    noteMajorVersionHop(previousVersion, version);

    if (backupEngineDir) {
      await removeDir(backupEngineDir);
    }

    outro(`Firefox ${version} is ready!`);
  } catch (error: unknown) {
    if (replacementActivated && backupEngineDir) {
      await restorePreviousEngine({
        engineDir,
        backupDir: backupEngineDir,
        reason: error,
      });
    }
    throw error;
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

  const config = await loadConfig(projectRoot),
    version = config.firefox.version;
  const paths = getProjectPaths(projectRoot);
  // Captured before any state update so the post-download major-hop
  // notice compares against what was actually on disk until now.
  const previousState = await loadState(projectRoot);
  const previousVersion = previousState.downloadedVersion;

  info(`Firefox version: ${version}`);

  await checkDiskSpace(projectRoot, 5 * 1024 * 1024 * 1024, warn);

  // A legitimate holder of this lock runs for 10+ minutes (download +
  // extract + git indexing). A 30 s timeout fails the second invocation with
  // "remove the lock directory if it is stale" advice while the lock is
  // actively held, which is dangerous guidance mid-extraction. Wait generously
  // instead: a dead holder is reaped within seconds by the PID-based stale
  // probe, so a long timeout only ever waits on real work.
  const downloadLockOptions = {
    timeoutMs: 30 * 60_000,
    onTimeoutMessage:
      'Timed out waiting for another FireForge download to finish. ' +
      'If no other `fireforge download` is running, remove .fireforge/download.fireforge.lock and retry.',
    onStaleLockMessage: (ageMs: number) =>
      `Removing download lock left behind by a crashed run (${Math.round(ageMs / 1000)}s old).`,
  };

  await withFileLock(
    join(paths.fireforgeDir, 'download.fireforge.lock'),
    async () => {
      // Reclaim multi-GB partial trees left behind by interrupted runs.
      // Safe under the download lock: any `.tmp-*`/`.replacement-*` dir
      // present now is orphaned, since live ones only exist while a
      // download holds this lock. `.backup-*` dirs are not swept: a
      // backup can hold the previous engine after a failed forced
      // replacement and is the operator's recovery copy.
      const sweptDirs = await sweepOrphanedEngineWorkDirs(paths.engine);
      if (sweptDirs.length > 0) {
        info(
          `Removed ${sweptDirs.length} orphaned working director${sweptDirs.length === 1 ? 'y' : 'ies'} from interrupted downloads.`
        );
      }

      let installEngineDir = paths.engine;
      let replacementEngineDir: string | undefined;
      let backupEngineDir: string | undefined;
      let replacementActivated = false;

      // Check if engine already exists
      if (await pathExistsStrict(paths.engine)) {
        if (!options.force) {
          if (await isGitRepository(paths.engine)) {
            try {
              await getHead(paths.engine);
            } catch (error: unknown) {
              if (isMissingHeadError(error)) {
                // Partial init detected. Attempt to resume instead of
                // requiring --force.
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
                    // The non-TTY spinner fallback in `src/utils/logger.ts`
                    // already calls `p.log.step(msg)` from `message()`, so
                    // forwarding the progress message is the single authority
                    // in both TTY and non-TTY modes. Calling `step(message)`
                    // explicitly here as well prints the same line twice in
                    // CI logs.
                    onProgress: (message) => {
                      resumeSpinner.message(message);
                    },
                  });
                  const baseCommit = await getHead(paths.engine);
                  resumeSpinner.stop('Git repository resumed successfully');

                  // Restore patch-touched files before stamping state. If this
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

                  await noteUnappliedPatches(paths.patches);
                  noteMajorVersionHop(previousVersion, version);

                  outro(`Firefox ${version} is ready! (resumed from partial init)`);
                  return;
                } catch (error: unknown) {
                  resumeSpinner.error('Resume failed');
                  // Preserve the underlying cause so the operator sees why
                  // the resume failed (timeout, permission denied, corrupted
                  // object, disk full) instead of only the generic "partial
                  // engine exists" story. The cause reaches them through the
                  // CLI boundary's chain walk under --verbose (src/cli.ts),
                  // which is what makes PartialEngineExistsError's "re-run
                  // with --verbose" promise true.
                  throw new PartialEngineExistsError(paths.engine, toError(error));
                }
              }
              // Re-throw unexpected git errors (corrupted objects, permission
              // denied, …) wrapped in PartialEngineExistsError so the user sees
              // both narratives: "we detected a partial engine and attempted
              // resume" and the underlying git failure. Without the wrap the
              // raw git error loses the context that resume was in flight.
              throw new PartialEngineExistsError(paths.engine, toError(error));
            }
          }

          throw new EngineExistsError(paths.engine);
        }

        // The replacement deletes the old tree once the new one is active,
        // so anything not in patches/ is gone for good. Ask before fetching.
        const loss = await describeForcedReplacementLoss(
          paths.engine,
          paths.patches,
          previousState.baseCommit
        );
        if (
          loss !== undefined &&
          !(await confirmDirtyEngineReset({
            engineDir: paths.engine,
            yes: options.yes ?? false,
            dirty: true,
            refusalDetail: loss,
            nonInteractiveCommand: 'fireforge download --force --yes',
            argumentName: '--yes',
            warningMessage: loss,
            promptMessage: 'Discard the existing engine/ and download a fresh one?',
            cancelMessage: 'Download cancelled; engine/ left untouched',
          }))
        ) {
          return;
        }

        replacementEngineDir = `${paths.engine}.replacement-${randomUUID()}`;
        backupEngineDir = `${paths.engine}.backup-${randomUUID()}`;
        installEngineDir = replacementEngineDir;
        warn(
          'Preparing replacement engine directory; existing engine/ will remain in place until the new archive downloads, validates, and extracts.'
        );
      }

      // Ensure cache directory exists
      const cacheDir = join(paths.fireforgeDir, 'cache');
      await ensureDir(cacheDir);

      try {
        await downloadAndExtractFirefox({
          version,
          product: config.firefox.product,
          engineDir: installEngineDir,
          cacheDir,
          ...(config.firefox.sha256 !== undefined ? { sha256: config.firefox.sha256 } : {}),
          ...(config.firefox.candidate !== undefined
            ? { candidate: config.firefox.candidate }
            : {}),
          ...(config.firefox.allowUnverifiedDownload !== undefined
            ? { allowUnverifiedDownload: config.firefox.allowUnverifiedDownload }
            : {}),
        });

        if (replacementEngineDir && backupEngineDir) {
          warn('Activating replacement engine directory...');
          await activateReplacementEngine({
            engineDir: paths.engine,
            replacementDir: replacementEngineDir,
            backupDir: backupEngineDir,
          });
          replacementActivated = true;
          installEngineDir = paths.engine;
        }
      } catch (error: unknown) {
        if (replacementEngineDir) {
          await removeDir(replacementEngineDir);
        }
        throw error;
      }

      await initializeDownloadedEngine({
        projectRoot,
        patchesDir: paths.patches,
        version,
        previousVersion,
        engineDir: installEngineDir,
        replacementActivated,
        ...(backupEngineDir !== undefined ? { backupEngineDir } : {}),
      });
    },
    downloadLockOptions
  );
}

/** Registers the download command on the CLI program. */
export function registerDownload(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  program
    .command('download')
    .description('Download Firefox source')
    .option(
      '-f, --force',
      'Force re-download; discards engine/ including applied patches and unexported edits'
    )
    .option('-y, --yes', 'With --force: replace a dirty engine/ without the confirmation prompt')
    .action(
      withErrorHandling(async (options: { force?: boolean; yes?: boolean }) => {
        await downloadCommand(getProjectRoot(), pickDefined(options));
      })
    );
}
