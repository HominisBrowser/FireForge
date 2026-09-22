// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge rebase`: semi-automated Firefox source version upgrade.
 *
 * Orchestrates the full patch-rebase workflow:
 *   1. Reset engine to baseline
 *   2. Apply each patch with escalating context reduction (git apply -C<n>)
 *   3. Pause on failures for manual resolution
 *   4. Re-export successfully applied patches with the new version stamp
 *
 * Supports `--continue` (resume after manual fix) and `--abort` (cancel).
 */

import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState } from '../../core/config.js';
import { assertEngineGitReady } from '../../core/engine-precondition.js';
import { clearAppliedFurnaceState } from '../../core/furnace-config.js';
import { getHead, resetChanges } from '../../core/git.js';
import { discoverPatches } from '../../core/patch-files.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { getPatchSourceVersion } from '../../core/patch-source-metadata.js';
import { type DryRunReplay, replayQueueIndexOnly } from '../../core/rebase-dry-run.js';
import type { RebaseSession } from '../../core/rebase-session.js';
import {
  getRebaseSessionPath,
  readRebaseSession,
  saveRebaseSession,
} from '../../core/rebase-session.js';
import { GeneralError } from '../../errors/base.js';
import {
  CorruptRebaseSessionError,
  RebaseDryRunRejectError,
  RebaseSessionExistsError,
} from '../../errors/rebase.js';
import type { CommandContext } from '../../types/cli.js';
import type { RebaseOptions } from '../../types/commands/index.js';
import { info, intro, outro, spinner, warn } from '../../utils/logger.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
} from '../../utils/options.js';
import { compareFirefoxVersions, parsePositiveIntegerFlag } from '../../utils/validation.js';
import { handleAbort } from './abort.js';
import { confirmDirtyEngineReset } from './confirm.js';
import { handleContinue } from './continue.js';
import { runPatchLoop } from './patch-loop.js';

// ── Fresh start ──

async function handleFreshStart(projectRoot: string, options: RebaseOptions): Promise<void> {
  const isDryRun = options.dryRun === true;
  const maxFuzz = options.maxFuzz ?? 3;

  intro(isDryRun ? 'FireForge Rebase (dry run)' : 'FireForge Rebase');

  // One read decides liveness and validity: a pathExists pre-probe here left
  // a window where the file vanished between probe and read, reporting
  // "already in progress" with no session on disk.
  const existing = await readRebaseSession(projectRoot);
  if (existing.present) {
    // A corrupt session must not be reported as "already in progress": that
    // message tells the operator to run --continue or --abort, and both of
    // those then report "no rebase session in progress".
    if (!existing.valid) {
      throw new CorruptRebaseSessionError(getRebaseSessionPath(projectRoot), existing.reason);
    }
    throw new RebaseSessionExistsError();
  }

  const paths = getProjectPaths(projectRoot);

  // Keeps the rebase-specific tail on the unborn-HEAD remediation. Skipping
  // this check in --dry-run leaves the real run to fail on
  // `git rev-parse HEAD`.
  await assertEngineGitReady(paths.engine, { unbornHeadSuffix: ', then retry the rebase.' });

  const config = await loadConfig(projectRoot);
  const currentVersion = config.firefox.version;

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest || manifest.patches.length === 0) {
    throw new GeneralError('No patches found in manifest. Nothing to rebase.');
  }

  // Determine the "from" version from the patch stamps. A queue can carry
  // several: patches re-exported since the last hop are stamped newer than
  // untouched ones. The oldest stamp is "from", compared semantically (a
  // lexical sort put 153.10.0esr before 153.2.0esr).
  const versionCounts = new Map<string, number>();
  for (const patch of manifest.patches) {
    const version = getPatchSourceVersion(patch);
    versionCounts.set(version, (versionCounts.get(version) ?? 0) + 1);
  }
  const sortedVersions = [...versionCounts.keys()].sort(compareFirefoxVersions);
  const fromVersion = sortedVersions[0] ?? currentVersion;
  const fromProduct =
    manifest.patches.find((p) => getPatchSourceVersion(p) === fromVersion)?.sourceProduct ??
    config.firefox.product;

  if (versionCounts.size === 1 && fromVersion === currentVersion) {
    info('All patches already match the current Firefox version. Nothing to rebase.');
    outro('Rebase not needed');
    return;
  }

  info(`Rebasing patches: ${fromVersion} → ${currentVersion}`);
  if (versionCounts.size > 1) {
    info(
      `Patch stamps: ${sortedVersions.map((v) => `${versionCounts.get(v)} at ${v}`).join(', ')}`
    );
  }
  // The rebase replays onto whatever engine/ holds. The pin is the target,
  // so an engine still on another version means the download step has not
  // run yet and every verdict below would be against the wrong tree.
  const engineVersion = (await loadState(projectRoot)).downloadedVersion;
  if (engineVersion !== undefined && engineVersion !== currentVersion) {
    warn(
      `engine/ holds ${engineVersion}, not the pinned target ${currentVersion}. ` +
        'Run "fireforge download --force" first, or the rebase applies onto the old source.'
    );
  }
  info(`Found ${manifest.patches.length} patch(es)`);
  info(`Max context-reduction steps (fuzz-like): ${maxFuzz}`);

  if (isDryRun) {
    const patches = await discoverPatches(paths.patches);
    const replaySpinner = spinner(`Replaying ${patches.length} patch(es) on a private index...`);
    let replay: DryRunReplay;
    try {
      replay = await replayQueueIndexOnly(paths.engine, patches, maxFuzz);
      replaySpinner.stop('Replay finished; engine/ untouched');
    } catch (error: unknown) {
      replaySpinner.error('Replay failed');
      throw error;
    }
    reportDryRunReplay(replay);
    return;
  }

  if (
    !(await confirmDirtyEngineReset({
      engineDir: paths.engine,
      yes: options.yes ?? false,
      nonInteractiveCommand: 'fireforge rebase --yes',
      argumentName: '--yes',
      warningMessage:
        'The engine directory has uncommitted changes that will be lost by the rebase.',
      promptMessage: 'Discard uncommitted changes and start rebase?',
      cancelMessage: 'Rebase cancelled',
    }))
  ) {
    return;
  }

  // Record pre-rebase commit for --abort
  const preRebaseCommit = await getHead(paths.engine);

  // Reset engine to baseline
  const resetSpinner = spinner('Resetting engine to baseline...');
  await resetChanges(paths.engine);
  resetSpinner.stop('Engine reset to baseline');

  // Clear Furnace state: the engine no longer contains deployed components.
  await clearAppliedFurnaceState(projectRoot);

  // Create rebase session
  const allPatches = await discoverPatches(paths.patches);
  const session: RebaseSession = {
    startedAt: new Date().toISOString(),
    fromProduct,
    toProduct: config.firefox.product,
    fromVersion,
    toVersion: currentVersion,
    preRebaseCommit,
    patches: allPatches.map((p) => ({
      filename: p.filename,
      status: 'pending' as const,
    })),
    currentIndex: 0,
  };
  await saveRebaseSession(projectRoot, session);

  // Run the patch loop
  await runPatchLoop(
    projectRoot,
    session,
    paths,
    maxFuzz,
    resolveWaitLockSeconds(options.waitLock)
  );
}

/**
 * Prints one line per patch and a tally, then fails the run when any patch
 * rejects: a dry run that exits 0 must mean the real rebase would apply the
 * whole queue.
 */
function reportDryRunReplay(replay: DryRunReplay): void {
  let reduced = 0;
  const rejected: string[] = [];
  for (const [index, verdict] of replay.verdicts.entries()) {
    const cascade =
      replay.firstRejectIndex !== undefined && index > replay.firstRejectIndex
        ? ' (after an earlier reject; may cascade from it)'
        : '';
    switch (verdict.outcome) {
      case 'clean':
        info(`  clean            ${verdict.filename}`);
        break;
      case 'reduced-context':
        reduced += 1;
        info(
          `  reduced context  ${verdict.filename} (step ${verdict.step}, ${verdict.contextArg})`
        );
        break;
      case 'reject': {
        rejected.push(verdict.filename);
        const files = verdict.files.length > 0 ? verdict.files.join(', ') : 'see git output';
        warn(`  reject           ${verdict.filename}: ${files}${cascade}`);
        break;
      }
    }
  }
  const clean = replay.verdicts.length - reduced - rejected.length;
  info(
    `[dry-run] ${replay.verdicts.length} patch(es): ${clean} clean, ${reduced} with reduced context, ${rejected.length} rejected.`
  );
  if (rejected.length > 0) {
    throw new RebaseDryRunRejectError(rejected);
  }
  outro('Dry run complete: every patch applies');
}

// ── Public API ──

/**
 * Runs the rebase command to orchestrate a Firefox source version upgrade.
 * @param projectRoot - Root directory of the project
 * @param options - Rebase options
 */
export async function rebaseCommand(
  projectRoot: string,
  options: RebaseOptions = {}
): Promise<void> {
  if (options.abort) {
    return handleAbort(projectRoot, options.yes);
  }

  if (options.continue) {
    return handleContinue(
      projectRoot,
      options.maxFuzz ?? 3,
      resolveWaitLockSeconds(options.waitLock)
    );
  }

  return handleFreshStart(projectRoot, options);
}

/** Registers the rebase command on the CLI program. */
export function registerRebase(
  program: Command,
  { getProjectRoot, withErrorHandling }: CommandContext
): void {
  const command = program
    .command('rebase')
    .description(
      'Semi-automated Firefox source version upgrade — apply patches with drift tolerance and re-export'
    )
    .option('--continue', 'Resume after manually resolving a failed patch')
    .option('--abort', 'Cancel the rebase and restore engine to pre-rebase state')
    .option(
      '--dry-run',
      'Replay the queue onto the engine base commit in a private index and report each patch as clean, reduced-context or reject (exit 6 on any reject); engine/ is not touched'
    )
    .option(
      '--max-fuzz <n>',
      'Maximum context-reduction steps for git apply -C<n> (fuzz-like drift tolerance; default: 3)',
      commanderArgParser((v) => parsePositiveIntegerFlag('--max-fuzz', v))
    )
    .option('-y, --yes', 'Skip dirty-tree confirmation prompt');
  addWaitLockOption(command).action(
    withErrorHandling(
      async (options: {
        continue?: boolean;
        abort?: boolean;
        dryRun?: boolean;
        maxFuzz?: number;
        yes?: boolean;
        waitLock?: boolean | number;
      }) => {
        await rebaseCommand(getProjectRoot(), pickDefined(options));
      }
    )
  );
}
