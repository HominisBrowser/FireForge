// SPDX-License-Identifier: EUPL-1.2
/**
 * `fireforge patch stage <name>...`: stages the named patches' `.patch`
 * files and only their rows of `patches/patches.json` in the project
 * repository's git index.
 *
 * The case it exists for: several sessions edit one checkout's queue, and
 * each must commit only its own patches. Staging the whole manifest takes
 * every session's rows; staging one owner's hunks of it with
 * `git apply --cached --unidiff-zero` placed a kept insertion at its
 * new-side line number once a dropped hunk above had shifted the file, and
 * an invalid manifest was committed. This command builds the staged
 * manifest from HEAD's rows plus the named working rows (see
 * `core/patch-manifest-stage.ts`), validates it, and writes it straight to
 * the index with `git hash-object` + `git update-index`. The working copy
 * is never touched, and nothing is committed.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';

import { Command } from 'commander';

import { getProjectPaths } from '../../core/config.js';
import { git } from '../../core/git-base.js';
import { withPatchDirectoryLock } from '../../core/patch-lock.js';
import {
  loadPatchesManifestForWrite,
  resolvePatchIdentifier,
  validatePatchesManifest,
} from '../../core/patch-manifest.js';
import {
  mergeStagedManifest,
  serializeStagedManifest,
  type StagedManifest,
} from '../../core/patch-manifest-stage.js';
import { GeneralError, InvalidArgumentError } from '../../errors/base.js';
import type { CommandContext } from '../../types/cli.js';
import type { PatchesManifest, PatchStageOptions } from '../../types/commands/index.js';
import { toError } from '../../utils/errors.js';
import { pathExists } from '../../utils/fs.js';
import { info, intro, outro } from '../../utils/logger.js';
import { addWaitLockOption, pickDefined, resolveWaitLockSeconds } from '../../utils/options.js';
import { exec } from '../../utils/process.js';

/** A project-relative path in git's separator. */
function gitPath(projectRoot: string, path: string): string {
  return relative(projectRoot, path).split(sep).join('/');
}

/** HEAD's manifest, or null when HEAD has none (or there is no HEAD yet). */
async function readHeadManifest(
  projectRoot: string,
  manifestPath: string
): Promise<PatchesManifest | null> {
  const shown = await exec('git', ['show', `HEAD:./${manifestPath}`], { cwd: projectRoot });
  if (shown.exitCode !== 0) return null;
  try {
    return validatePatchesManifest(JSON.parse(shown.stdout));
  } catch (error: unknown) {
    throw new GeneralError(
      `HEAD's ${manifestPath} is not a valid manifest (${toError(error).message}); stage it by hand.`
    );
  }
}

/** Resolves each identifier to a filename, against the working rows then HEAD's. */
function resolveFilenames(
  identifiers: readonly string[],
  working: PatchesManifest,
  head: PatchesManifest | null
): Set<string> {
  const filenames = new Set<string>();
  for (const identifier of identifiers) {
    const live = resolvePatchIdentifier(identifier, working.patches);
    // A patch deleted (or renamed away) in the working copy is named by its
    // HEAD filename, so its row can be staged as removed.
    const gone = (head?.patches ?? []).find(
      (row) => row.filename === identifier || row.filename === `${identifier}.patch`
    );
    const filename = live?.filename ?? gone?.filename;
    if (filename === undefined) {
      throw new InvalidArgumentError(
        `No patch "${identifier}" in the working manifest or at HEAD.`,
        identifier
      );
    }
    filenames.add(filename);
  }
  return filenames;
}

/** Stages one `.patch` file: its content, or its removal when it is gone. */
async function stagePatchFile(projectRoot: string, patchPath: string): Promise<void> {
  if (await pathExists(join(projectRoot, patchPath))) {
    await git(['add', '--', patchPath], projectRoot);
    return;
  }
  const tracked = await exec('git', ['ls-files', '--error-unmatch', '--', patchPath], {
    cwd: projectRoot,
  });
  if (tracked.exitCode === 0) {
    await git(['rm', '--cached', '--quiet', '--', patchPath], projectRoot);
  }
}

/** Writes `content` as a blob and points the index entry at it. */
async function stageBlob(projectRoot: string, path: string, content: string): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'fireforge-stage-'));
  try {
    const file = join(scratch, 'patches.json');
    await writeFile(file, content);
    const sha = (await git(['hash-object', '-w', '--no-filters', file], projectRoot)).trim();
    await git(['update-index', '--add', '--cacheinfo', `100644,${sha},${path}`], projectRoot);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Runs the `patch stage` command.
 *
 * @param projectRoot - Project root directory (a git working tree)
 * @param identifiers - Patch filenames, ordinals or names to stage
 * @param options - Command options
 */
export async function patchStageCommand(
  projectRoot: string,
  identifiers: readonly string[],
  options: PatchStageOptions = {}
): Promise<void> {
  intro(options.dryRun ? 'FireForge patch stage (dry run)' : 'FireForge patch stage');
  const probe = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectRoot });
  if (probe.exitCode !== 0 || probe.stdout.trim() !== 'true') {
    throw new GeneralError('patch stage needs the project to be a git working tree.');
  }

  const { patches: patchesDir } = getProjectPaths(projectRoot);
  const manifestPath = gitPath(projectRoot, join(patchesDir, 'patches.json'));
  // Under the patch lock, so the rows and `.patch` files staged are one
  // consistent snapshot rather than a peer's half-finished write.
  await withPatchDirectoryLock(
    patchesDir,
    async () => {
      const working = await loadPatchesManifestForWrite(patchesDir);
      if (working === null) {
        throw new GeneralError(`No ${manifestPath} to stage.`);
      }
      const head = await readHeadManifest(projectRoot, manifestPath);
      const filenames = resolveFilenames(identifiers, working, head);

      let staged: StagedManifest;
      try {
        staged = mergeStagedManifest(head, working, filenames);
      } catch (error: unknown) {
        throw new GeneralError(`Refusing to stage: ${toError(error).message}.`);
      }
      const prefix = options.dryRun === true ? '[dry-run] ' : '';
      for (const { filename, change } of staged.changes) {
        info(`${prefix}${filename}: row ${change}; .patch file staged`);
      }
      if (options.dryRun === true) return;

      await stageBlob(projectRoot, manifestPath, serializeStagedManifest(staged.manifest));
      for (const filename of filenames) {
        await stagePatchFile(projectRoot, gitPath(projectRoot, join(patchesDir, filename)));
      }
      info(
        `Staged ${filenames.size} patch(es) and their ${manifestPath} rows. Other rows stay as at HEAD; ` +
          'nothing was committed.'
      );
    },
    { waitLockSeconds: resolveWaitLockSeconds(options.waitLock), command: 'patch stage' }
  );
  outro(options.dryRun ? 'Dry run complete — nothing staged' : 'Patch stage complete');
}

/**
 * Registers the `patch stage` subcommand on the `patch` parent.
 *
 * @param parent - Parent Commander command
 * @param context - Shared CLI registration context
 */
export function registerPatchStage(parent: Command, context: CommandContext): void {
  const { getProjectRoot, withErrorHandling } = context;
  const command = parent
    .command('stage <names...>')
    .description(
      "Stage the named patches' .patch files and only their patches.json rows in the git index " +
        "(HEAD's rows for every other patch); validates the staged manifest, commits nothing"
    )
    .option('--dry-run', 'Show which rows would be staged without touching the index');
  addWaitLockOption(command).action(
    withErrorHandling(async (names: string[], options: PatchStageOptions) => {
      await patchStageCommand(getProjectRoot(), names, pickDefined(options));
    })
  );
}
