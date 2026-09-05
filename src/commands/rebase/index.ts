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

import { getProjectPaths, loadConfig } from '../../core/config.js';
import { assertEngineGitReady } from '../../core/engine-precondition.js';
import { clearAppliedFurnaceState } from '../../core/furnace-config.js';
import { getHead, resetChanges } from '../../core/git.js';
import { discoverPatches } from '../../core/patch-files.js';
import { loadPatchesManifest } from '../../core/patch-manifest.js';
import { getPatchSourceVersion } from '../../core/patch-source-metadata.js';
import type { RebaseSession } from '../../core/rebase-session.js';
import {
  getRebaseSessionPath,
  readRebaseSession,
  saveRebaseSession,
} from '../../core/rebase-session.js';
import { GeneralError } from '../../errors/base.js';
import { CorruptRebaseSessionError, RebaseSessionExistsError } from '../../errors/rebase.js';
import type { CommandContext } from '../../types/cli.js';
import type { RebaseOptions } from '../../types/commands/index.js';
import { info, intro, outro, spinner } from '../../utils/logger.js';
import {
  addWaitLockOption,
  commanderArgParser,
  pickDefined,
  resolveWaitLockSeconds,
} from '../../utils/options.js';
import { parsePositiveIntegerFlag } from '../../utils/validation.js';
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

  // Determine the "from" version from the patches
  const patchVersions = new Set(manifest.patches.map((p) => getPatchSourceVersion(p)));
  const patchProducts = new Set(manifest.patches.map((p) => p.sourceProduct).filter(Boolean));
  const sortedVersions = [...patchVersions].sort();
  const fromVersion = sortedVersions[0] ?? currentVersion;
  const fromProduct = [...patchProducts].sort()[0] ?? config.firefox.product;

  if (patchVersions.size === 1 && fromVersion === currentVersion) {
    info('All patches already match the current Firefox version. Nothing to rebase.');
    outro('Rebase not needed');
    return;
  }

  info(`Rebasing patches: ${fromVersion} → ${currentVersion}`);
  info(`Found ${manifest.patches.length} patch(es)`);
  info(`Max context-reduction steps (fuzz-like): ${maxFuzz}`);

  if (isDryRun) {
    info('[dry-run] Would reset engine, apply patches with context reduction, and re-export.');
    outro('Dry run complete');
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
    .option('--dry-run', 'Show what would happen without modifying anything')
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
