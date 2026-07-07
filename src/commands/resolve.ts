// SPDX-License-Identifier: EUPL-1.2
import { join } from 'node:path';

import { confirm } from '@clack/prompts';
import { Command } from 'commander';

import { getProjectPaths, loadConfig, loadState, updateState } from '../core/config.js';
import { isGitRepository } from '../core/git.js';
import { getStagedDiffForFiles } from '../core/git-diff.js';
import { stageFiles, unstageFiles } from '../core/git-file-ops.js';
import { extractAffectedFiles } from '../core/patch-apply.js';
import { updatePatchAndMetadata } from '../core/patch-export.js';
import { loadPatchesManifest } from '../core/patch-manifest.js';
import { buildPatchSourceMetadata } from '../core/patch-source-metadata.js';
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
 * Options accepted by {@link resolveCommand}.
 */
export interface ResolveCommandOptions {
  /**
   * Skip the interactive "Have you finished fixing the files?"
   * confirmation prompt and treat the resolution as complete.
   *
   * Motivating case (2026-04-21 eval, Finding #18): a scripted or
   * CI-assisted recovery flow that has already completed the manual
   * merge step cannot advance through `fireforge resolve` because the
   * TTY guard refuses non-interactive invocations outright. `--yes`
   * is the explicit opt-in for those flows: the operator is asserting
   * they have already done the merge, and the command proceeds
   * straight to the patch-refresh + state-clear path.
   *
   * The guard without `--yes` is preserved — running `resolve` with
   * no TTY and no `--yes` still refuses so an accidental pipe-into
   * invocation doesn't silently commit whatever the engine happens
   * to contain.
   */
  yes?: boolean;
}

/**
 * Runs the resolve command to fix broken patches.
 * @param projectRoot - Root directory of the project
 * @param options - Optional flags; see {@link ResolveCommandOptions}.
 */
export async function resolveCommand(
  projectRoot: string,
  options: ResolveCommandOptions = {}
): Promise<void> {
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

  // Non-interactive mode requires an explicit `--yes` to proceed: the
  // operator is asserting the manual merge is complete and the
  // refreshed diff is the one to record. Without `--yes`, an accidental
  // pipe / CI shell could otherwise commit whatever the engine
  // currently contains. 2026-04-21 eval (Finding #18): a scripted
  // recovery flow was dead-ended by the unconditional TTY refusal.
  if (!(process.stdin.isTTY && process.stdout.isTTY) && !options.yes) {
    throw new GeneralError(
      'Cannot run "fireforge resolve" in non-interactive mode. Use a terminal with TTY support, or pass "--yes" to skip the interactive confirmation once the manual merge is complete.'
    );
  }

  if (!options.yes) {
    const finished = await confirm({
      message: 'Have you finished manually fixing the files in engine/?',
      initialValue: true,
    });

    if (isCancel(finished) || !finished) {
      info('Please fix the conflicts and run "fireforge resolve" again.');
      outro('Resolution paused');
      return;
    }
  }

  const manifest = await loadPatchesManifest(paths.patches);
  if (!manifest) {
    throw new GeneralError('Patches manifest not found.');
  }

  const patchMetadata = manifest.patches.find((p) => p.filename === patchFilename);
  if (!patchMetadata) {
    throw new ResolutionError(`Patch ${patchFilename} not found in manifest.`);
  }

  // Refuse to proceed if the patch file was deleted between the conflict
  // and the resolve. Without this check, `updatePatchAndMetadata` would
  // throw a less actionable "patch file is missing" error from inside
  // the lock; the explicit precondition lets us point the user at the
  // exact recovery path.
  const patchPath = join(paths.patches, patchFilename);
  if (!(await pathExists(patchPath))) {
    throw new ResolutionError(
      `Patch file ${patchFilename} is missing on disk. ` +
        'Delete the "pendingResolution" key from state.json to clear the stale conflict, ' +
        'or restore the patch file before re-running resolve.'
    );
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

    // Atomically write the patch body and the metadata update under the
    // shared patch-directory lock. Replaces the previous lock-free
    // sequence of updatePatch + updatePatchMetadata, which a concurrent
    // import / export / re-export / patch reorder / patch compact could
    // interleave with and leave the manifest disagreeing with the
    // freshly-written patch body.
    //
    // Always recompute `filesAffected` from the diff content itself. The
    // eval finding #16 scenario: the user's manual fix removed every
    // hunk for one file while the file still existed on disk, so the
    // pre-0.16.0 gate of "update filesAffected only when files were
    // deleted from disk" left the manifest claiming a file the patch
    // body no longer targeted. The next `fireforge import` then failed
    // the patch-manifest consistency check even though resolve reported
    // success. `extractAffectedFiles` already owns the canonical
    // "parse a diff, return its target paths" logic used by export and
    // consistency — using it here keeps resolve in agreement with every
    // other writer.
    const diffFilesAffected = extractAffectedFiles(diffContent);
    const config = await loadConfig(projectRoot);
    await updatePatchAndMetadata(paths.patches, patchFilename, diffContent, {
      filesAffected: diffFilesAffected,
      ...buildPatchSourceMetadata(config.firefox),
    });

    // Cleanup: Clear pendingResolution from state.json transactionally so
    // we don't clobber concurrent updates to unrelated keys (e.g. another
    // command writing buildMode or baseCommit between our loadState and
    // saveState). The updater function runs inside the state-file lock
    // with the freshest on-disk state, so only pendingResolution is
    // affected.
    await updateState(projectRoot, (current) => {
      const next = { ...current };
      delete next.pendingResolution;
      return next;
    });

    s.stop(`Updated ${patchFilename}`);
    success('Patch updated successfully and resolution state cleared.');
    info(
      'Patch updated. Run "fireforge import" next to resume the queue from this point — resolve only refreshes the one broken patch, it does not continue applying the remaining patches itself.'
    );
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
    .description(
      'Update a broken patch with manual fixes (then run "fireforge import" to resume the queue)'
    )
    .option(
      '-y, --yes',
      'Skip the interactive confirmation prompt. Use for non-interactive automation flows (CI, scripted recovery) after the manual merge is complete.'
    )
    .action(
      withErrorHandling(async (options: { yes?: boolean }) => {
        await resolveCommand(getProjectRoot(), options);
      })
    );
}
