// SPDX-License-Identifier: EUPL-1.2
import { randomUUID } from 'node:crypto';
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
import { getDirtyFiles } from '../core/git-status.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { formatMajorVersionHopNotice } from '../core/toolchain-preflight.js';
import { GeneralError } from '../errors/base.js';
import { EngineExistsError, PartialEngineExistsError } from '../errors/download.js';
import type { CommandContext } from '../types/cli.js';
import type { DownloadOptions } from '../types/commands/index.js';
import type { FirefoxProduct } from '../types/config.js';
import { toError } from '../utils/errors.js';
import { checkDiskSpace, ensureDir, pathExists, pathExistsStrict, removeDir } from '../utils/fs.js';
import type { SpinnerHandle } from '../utils/logger.js';
import { info, intro, outro, spinner, warn } from '../utils/logger.js';
import { addWaitLockOption, pickDefined } from '../utils/options.js';
import {
  activateReplacementEngine,
  describeForcedReplacementLoss,
  forcedReplacementFingerprint,
  getPatchTouchedFiles,
  restorePreviousEngine,
} from './download-replace.js';
import { confirmDirtyEngineReset } from './rebase/confirm.js';
import { runUnderEngineLock } from './with-engine-lock.js';

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

/**
 * Indexes a freshly extracted tree into git and restores patch-touched files
 * to baseline. Returns the baseline commit. `engineDir` is either engine/
 * itself (a first download) or the private replacement directory of a forced
 * one, which nothing else reads until it is activated.
 */
async function indexDownloadedEngine(args: {
  engineDir: string;
  patchesDir: string;
  replacement: boolean;
}): Promise<string> {
  const { engineDir, patchesDir, replacement } = args;
  // The git indexing phase of `download` can block for minutes on a ~600 MB
  // Firefox tree. Emit a one-line heads-up banner before the spinner starts
  // so CI logs show the expected duration.
  info(
    'Indexing downloaded source into git (one-time; typically 3–5 minutes on a ~600 MB Firefox tree)...'
  );

  info('Git phase: initializing/resetting source repository metadata.');
  const gitSpinner = spinner('Initializing git repository (this may take a few minutes)...');
  let baseCommit: string;

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
      replacement
        ? 'Replacement engine failed during baseline git initialization; the existing engine/ was left untouched.'
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
  return baseCommit;
}

/** Records the downloaded baseline; runs under the engine-session lock. */
async function recordDownloadedEngine(args: {
  projectRoot: string;
  version: string;
  baseCommit: string;
  replaced: boolean;
}): Promise<void> {
  const { projectRoot, version, baseCommit, replaced } = args;
  if (replaced) {
    // --force installs a new baseCommit, which invalidates every applied
    // checksum in furnace-state.json.
    await clearAppliedFurnaceState(projectRoot);
  }
  await updateState(projectRoot, {
    downloadedVersion: version,
    baseCommit,
  });
}

/** Prints the post-download notes once the engine and state are in place. */
async function finishDownload(args: {
  patchesDir: string;
  version: string;
  previousVersion: string | undefined;
  suffix?: string;
}): Promise<void> {
  await noteUnappliedPatches(args.patchesDir);
  noteMajorVersionHop(args.previousVersion, args.version);
  outro(`Firefox ${args.version} is ready!${args.suffix ?? ''}`);
}

/**
 * Resumes an engine whose baseline git initialization was interrupted. Runs
 * under the engine-session lock: it commits into engine/.
 */
async function resumePartialEngine(args: {
  projectRoot: string;
  engineDir: string;
  patchesDir: string;
  version: string;
  previousVersion: string | undefined;
}): Promise<void> {
  const { projectRoot, engineDir, patchesDir, version, previousVersion } = args;
  info('Detected partially initialized engine. Attempting to resume...');

  // Snapshot patch-touched files that are already dirty so we
  // can preserve them after the resume commit.
  const patchFiles = await getPatchTouchedFiles(patchesDir);
  const preExistingDirty =
    patchFiles.size > 0
      ? new Set(await getDirtyFiles(engineDir, [...patchFiles]))
      : new Set<string>();

  const resumeSpinner = spinner('Resuming git repository initialization...');
  try {
    await resumeRepository(engineDir, {
      // The non-TTY spinner fallback in `src/utils/logger.ts` already calls
      // `p.log.step(msg)` from `message()`, so forwarding the progress
      // message is the single authority in both TTY and non-TTY modes.
      // Calling `step(message)` explicitly here as well prints the same line
      // twice in CI logs.
      onProgress: (message) => {
        resumeSpinner.message(message);
      },
    });
    const baseCommit = await getHead(engineDir);
    resumeSpinner.stop('Git repository resumed successfully');

    // Restore patch-touched files before stamping state. If this step fails
    // (disk full, permission denied, git object issue), state.json keeps the
    // previous downloadedVersion so the invariant "state.downloadedVersion
    // matches a clean engine" holds. A retry of `fireforge download` then
    // re-enters the resume path instead of declaring success against a dirty
    // engine.
    await cleanPatchTouchedFiles(engineDir, patchesDir, preExistingDirty);

    await updateState(projectRoot, {
      downloadedVersion: version,
      baseCommit,
    });
  } catch (error: unknown) {
    resumeSpinner.error('Resume failed');
    // Preserve the underlying cause so the operator sees why the resume
    // failed (timeout, permission denied, corrupted object, disk full)
    // instead of only the generic "partial engine exists" story. The cause
    // reaches them through the CLI boundary's chain walk under --verbose
    // (src/cli.ts), which is what makes PartialEngineExistsError's "re-run
    // with --verbose" promise true.
    throw new PartialEngineExistsError(engineDir, toError(error));
  }
  await finishDownload({
    patchesDir,
    version,
    previousVersion,
    suffix: ' (resumed from partial init)',
  });
}

/**
 * Refuses an existing engine/ without --force, resuming a partial git
 * initialization instead when that is what is there.
 */
async function handleExistingEngineWithoutForce(args: {
  projectRoot: string;
  engineDir: string;
  patchesDir: string;
  version: string;
  previousVersion: string | undefined;
  options: DownloadOptions;
}): Promise<void> {
  const { engineDir } = args;
  if (await isGitRepository(engineDir)) {
    try {
      await getHead(engineDir);
    } catch (error: unknown) {
      if (isMissingHeadError(error)) {
        // Partial init detected. Resume instead of requiring --force.
        await runUnderEngineLock(args.projectRoot, 'download', args.options, async () => {
          // Re-read under the lock: a peer may have finished or replaced it.
          if (!(await pathExistsStrict(engineDir))) throw new EngineExistsError(engineDir);
          await resumePartialEngine(args);
        });
        return;
      }
      // Re-throw unexpected git errors (corrupted objects, permission
      // denied, …) wrapped in PartialEngineExistsError so the user sees
      // both narratives: "we detected a partial engine and attempted
      // resume" and the underlying git failure. Without the wrap the
      // raw git error loses the context that resume was in flight.
      throw new PartialEngineExistsError(engineDir, toError(error));
    }
  }
  throw new EngineExistsError(engineDir);
}

/** The download-and-extract inputs every path shares. */
type ExtractInputs = Omit<Parameters<typeof downloadAndExtractFirefox>[0], 'engineDir'>;

/**
 * `download --force`: fetches, extracts and indexes the new tree into a
 * private replacement directory without holding the engine-session lock,
 * then takes the lock only to check that engine/ is still what the operator
 * confirmed discarding, swap the directories, and record the new baseline.
 */
async function replaceEngine(args: {
  projectRoot: string;
  engineDir: string;
  patchesDir: string;
  version: string;
  previousVersion: string | undefined;
  options: DownloadOptions;
  extract: ExtractInputs;
  confirmedFingerprint: string;
}): Promise<void> {
  const { projectRoot, engineDir, patchesDir, version, previousVersion, options } = args;
  const replacementDir = `${engineDir}.replacement-${randomUUID()}`;
  const backupDir = `${engineDir}.backup-${randomUUID()}`;
  warn(
    'Preparing replacement engine directory; existing engine/ will remain in place until the new archive downloads, validates, extracts, and is indexed.'
  );

  const swap = { activated: false };
  try {
    await downloadAndExtractFirefox({ ...args.extract, engineDir: replacementDir });
    const baseCommit = await indexDownloadedEngine({
      engineDir: replacementDir,
      patchesDir,
      replacement: true,
    });

    await runUnderEngineLock(projectRoot, 'download --force', options, async () => {
      if (
        (await forcedReplacementFingerprint(engineDir, projectRoot)) !== args.confirmedFingerprint
      ) {
        throw new GeneralError(
          'engine/ changed while the replacement downloaded, so it was not replaced: the ' +
            'confirmation covered the engine/ as it was then. Re-run "fireforge download --force" ' +
            'to review what would be discarded now.'
        );
      }
      warn('Activating replacement engine directory...');
      await activateReplacementEngine({ engineDir, replacementDir, backupDir });
      swap.activated = true;
      try {
        await recordDownloadedEngine({ projectRoot, version, baseCommit, replaced: true });
      } catch (error: unknown) {
        await restorePreviousEngine({ engineDir, backupDir, reason: error });
        throw error;
      }
      await removeDir(backupDir);
    });
  } finally {
    if (!swap.activated) await removeDir(replacementDir);
  }
  await finishDownload({ patchesDir, version, previousVersion });
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

      const cacheDir = join(paths.fireforgeDir, 'cache');
      const extract: ExtractInputs = {
        version,
        product: config.firefox.product,
        cacheDir,
        ...(config.firefox.sha256 !== undefined ? { sha256: config.firefox.sha256 } : {}),
        ...(config.firefox.candidate !== undefined ? { candidate: config.firefox.candidate } : {}),
        ...(config.firefox.allowUnverifiedDownload !== undefined
          ? { allowUnverifiedDownload: config.firefox.allowUnverifiedDownload }
          : {}),
      };

      if (await pathExistsStrict(paths.engine)) {
        if (!options.force) {
          await handleExistingEngineWithoutForce({
            projectRoot,
            engineDir: paths.engine,
            patchesDir: paths.patches,
            version,
            previousVersion,
            options,
          });
          return;
        }

        // The replacement deletes the old tree once the new one is active,
        // so anything not in patches/ is gone for good. Ask before fetching.
        const confirmedFingerprint = await forcedReplacementFingerprint(paths.engine, projectRoot);
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

        await ensureDir(cacheDir);
        await replaceEngine({
          projectRoot,
          engineDir: paths.engine,
          patchesDir: paths.patches,
          version,
          previousVersion,
          options,
          extract,
          confirmedFingerprint,
        });
        return;
      }

      // A first download creates engine/ and indexes it in place, so a
      // partial git initialization can be resumed. It holds the
      // engine-session lock throughout: no peer may see engine/ half-made.
      await ensureDir(cacheDir);
      await runUnderEngineLock(projectRoot, 'download', options, async () => {
        if (await pathExistsStrict(paths.engine)) throw new EngineExistsError(paths.engine);
        await downloadAndExtractFirefox({ ...extract, engineDir: paths.engine });
        const baseCommit = await indexDownloadedEngine({
          engineDir: paths.engine,
          patchesDir: paths.patches,
          replacement: false,
        });
        await recordDownloadedEngine({ projectRoot, version, baseCommit, replaced: false });
      });
      await finishDownload({ patchesDir: paths.patches, version, previousVersion });
    },
    downloadLockOptions
  );
}

/** Registers the download command on the CLI program. */
export function registerDownload(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const command = program
    .command('download')
    .description('Download Firefox source')
    .option(
      '-f, --force',
      'Force re-download; discards engine/ including applied patches and unexported edits'
    )
    .option('-y, --yes', 'With --force: replace a dirty engine/ without the confirmation prompt');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (options: { force?: boolean; yes?: boolean; waitLock?: boolean | number }) => {
        await downloadCommand(getProjectRoot(), pickDefined(options));
      }
    )
  );
}
