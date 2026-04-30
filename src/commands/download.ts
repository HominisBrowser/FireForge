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

  // Phase-switched spinners: the download phase runs with the byte-count
  // progress callbacks below; the extract phase is blocking tar-xz and
  // has no incremental progress, but it can take 30–90s on a ~600 MB
  // Firefox tree, so it gets its own spinner message. Before the phase
  // split, a single "Downloading Firefox … 100%" spinner covered both
  // — the first-run setup looked hung precisely when the archive had
  // already reached disk and `tar` was the long pole.
  let s = spinner(`Downloading Firefox ${version}...`);
  let lastPercent = 0;
  const phaseState: { value: 'download' | 'extract' } = { value: 'download' };

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
      },
      (phase) => {
        if (phase === 'extract' && phaseState.value === 'download') {
          s.stop(`Firefox ${version} downloaded`);
          phaseState.value = 'extract';
          s = spinner(
            `Extracting Firefox ${version}... (decompressing ~600 MB of source; typically 30–90s)`
          );
        }
      }
    );

    if (phaseState.value === 'extract') {
      s.stop(`Firefox ${version} extracted`);
    } else {
      s.stop(`Firefox ${version} downloaded`);
    }
  } catch (error: unknown) {
    s.error(phaseState.value === 'extract' ? 'Extraction failed' : 'Download failed');
    throw error;
  }

  // Finding #17: the git indexing phase of `download` can block for
  // minutes on a ~600 MB Firefox tree — the spinner updates less often
  // than operators expect during the monolithic `git add -A` pass, and
  // non-TTY shells see long stretches of silence. Emit a one-line
  // heads-up banner BEFORE the spinner starts so even a log-scraping
  // CI job notes the expected duration. The progress callbacks below
  // still fire as usual; this is an additional up-front signal, not a
  // replacement.
  info(
    'Indexing downloaded source into git (one-time; typically 1–3 minutes on a ~600 MB Firefox tree)...'
  );

  // Initialize git repository
  const gitSpinner = spinner('Initializing git repository (this may take a few minutes)...');
  let baseCommit: string | undefined;

  try {
    await initRepository(paths.engine, 'firefox', {
      // Same one-authority rule as the resume path above: the non-TTY
      // spinner fallback already emits `step(msg)` internally, so
      // calling `step()` in addition to `.message()` duplicated every
      // git-init progress line in CI logs.
      onProgress: (message) => {
        gitSpinner.message(message);
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
  // Wrapped in a dedicated spinner because the restore can itself take
  // tens of seconds on a ~600 MB Firefox tree: it walks every file in the
  // patch manifest, calls `git status` / `git checkout` for each, and the
  // eval's "download looks hung" report landed at least partly on this
  // post-commit window. An operator watching the CLI needs to see that
  // this phase is distinct from the preceding git-add work.
  //
  // This runs BEFORE updateState so a restore failure keeps the previous
  // downloadedVersion in state.json. The invariant we preserve is
  // "state.downloadedVersion matches a clean engine": stamping the new
  // version only after the restore succeeds means a failed clean-up will
  // re-enter the resume path on the next `fireforge download` rather than
  // reporting success against a dirty engine.
  const restoreSpinner = spinner('Restoring patch-touched files to baseline...');
  try {
    const restoreResult = await cleanPatchTouchedFiles(paths.engine, paths.patches);
    closeRestoreSpinner(restoreSpinner, restoreResult);
  } catch (error: unknown) {
    restoreSpinner.error('Failed to restore patch-touched files');
    throw error;
  }

  await updateState(projectRoot, {
    downloadedVersion: version,
    baseCommit,
  });

  await noteUnappliedPatches(paths.patches);

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
