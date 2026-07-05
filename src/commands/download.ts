// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, updateState } from '../core/config.js';
import { withFileLock } from '../core/file-lock.js';
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
import { formatMajorVersionHopNotice } from '../core/toolchain-preflight.js';
import { EngineExistsError, PartialEngineExistsError } from '../errors/download.js';
import type { CommandContext } from '../types/cli.js';
import type { DownloadOptions } from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, ensureDir, pathExists, pathExistsStrict, removeDir } from '../utils/fs.js';
import { info, intro, outro, spinner, verbose, warn } from '../utils/logger.js';
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
 * Outcome of {@link cleanPatchTouchedFiles}. `restored` is the number of
 * dirty patch-touched files that were reset to HEAD; `preserved` is the
 * number that were dirty before the download started and were left alone.
 * A `hadQueue: false` result means the project has no patches — callers
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
 * carries a non-empty patch queue but the just-downloaded engine has not
 * yet had any patches applied. The post-download spinner closes with
 * "Patch-touched files already match baseline" because a fresh tree IS at
 * baseline, but the 2026-04-25 eval saw operators read that as "patches
 * are restored" and skip the import step. The note is suppressed when
 * patches/ is missing or the manifest is empty so unconfigured projects
 * stay quiet.
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
 * happened. Three branches: empty queue → explicit no-op; queue present but
 * nothing dirty → "already clean"; queue with dirty files → the usual
 * "Patch-touched files restored" success line.
 *
 * Before 0.16.0 the spinner always closed with "Patch-touched files
 * restored", so a fresh project with zero patches saw a claim of restore
 * work that had not happened — misleading and easy to mistake for a
 * silent retry.
 */
function closeRestoreSpinner(
  restoreSpinner: ReturnType<typeof spinner>,
  result: CleanPatchResult
): void {
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

async function clearStaleFurnaceApplyState(projectRoot: string): Promise<void> {
  // --force installs a new baseCommit, which invalidates every applied
  // checksum in furnace-state.json. Preserve pendingRepair: authoring-side
  // rollback markers describe unresolved component workspace state and
  // should survive an engine refresh.
  const furnacePaths = getFurnacePaths(projectRoot);
  if (await pathExists(furnacePaths.furnaceState)) {
    await updateFurnaceState(projectRoot, (current) => ({
      ...(current.pendingRepair ? { pendingRepair: current.pendingRepair } : {}),
    }));
  }
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
}): Promise<void> {
  const { version, product, engineDir, cacheDir, sha256 } = args;
  let s = spinner(`Downloading Firefox ${version}...`);
  let lastPercent = 0;
  const phaseState: { value: 'download' | 'extract' } = { value: 'download' };

  try {
    await downloadFirefoxSource(
      version,
      product,
      engineDir,
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
      },
      (phase) => {
        if (phase === 'extract' && phaseState.value === 'download') {
          s.stop(`Firefox ${version} downloaded`);
          phaseState.value = 'extract';
          s = spinner(
            `Extracting Firefox ${version}... (decompressing ~600 MB of source; typically 30–90s)`
          );
        }
      },
      sha256,
      (message) => {
        s.message(message);
      }
    );

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
 * Prints the major-version-hop toolchain nudge when this download moved
 * the engine across a Firefox MAJOR version (152.0b7 → 153.0b8 drill:
 * the first post-hop build died in `mach configure` on a moved cbindgen
 * minimum, and nothing in the download output suggested re-running
 * `fireforge bootstrap`). Quiet on first downloads and same-major
 * re-downloads.
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

  // Finding #17: the git indexing phase of `download` can block for
  // minutes on a ~600 MB Firefox tree. Emit a one-line heads-up banner
  // before the spinner starts so CI logs show the expected duration.
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
      await clearStaleFurnaceApplyState(projectRoot);
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
  // Captured BEFORE any state update so the post-download major-hop
  // notice compares against what was actually on disk until now.
  const previousVersion = (await loadState(projectRoot)).downloadedVersion;

  info(`Firefox version: ${version}`);

  await checkDiskSpace(projectRoot, 5 * 1024 * 1024 * 1024, warn);

  await withFileLock(join(paths.fireforgeDir, 'download.fireforge.lock'), async () => {
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
                  // The non-TTY spinner fallback in `src/utils/logger.ts`
                  // already calls `p.log.step(msg)` from `message()`, so
                  // forwarding the progress message is the single authority
                  // in both TTY and non-TTY modes. Before 0.16.0 this
                  // callback also invoked `step(message)` explicitly when
                  // stdio was not a TTY, which printed the same step line
                  // twice in CI logs (once from the fallback, once from
                  // the explicit call).
                  onProgress: (message) => {
                    resumeSpinner.message(message);
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

                await noteUnappliedPatches(paths.patches);
                noteMajorVersionHop(previousVersion, version);

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
  });
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
